/**
 * Health probes for qBittorrent
 */

import { getEgressIP } from '../../docker';
import { type QbitCredentials } from '../../config';
import { httpGet, qbitHeaders, buildHeaders, parseJson } from '../http';
import type {
  QbitProbeResult,
  QbitEgressProbeResult,
} from '../types';

/**
 * Probe qBittorrent (whitelist bypass)
 */
export async function probeQbit(url: string | undefined, auth: QbitCredentials | null): Promise<QbitProbeResult> {
  const name = 'qBittorrent';
  if (url === undefined) return { name, ok: false, reason: 'container not found' };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => { controller.abort(); }, 3000);

  let ok = false;
  let version = '';
  let versionResult: { ok: boolean; out: string; err?: string } = { ok: false, out: '', err: '' };

  try {
    const headers = buildHeaders(qbitHeaders(url));

    const response = await fetch(`${url}/api/v2/app/webapiVersion`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    const body = await response.text();
    const code = response.status;

    if (code === 200 && !/^Forbidden/i.test(body)) {
      ok = true;
      version = body.trim();
      versionResult = { ok: true, out: body.trim() };
    } else {
      versionResult = { ok: false, out: body, err: `HTTP ${String(code)}` };
    }
  } catch (error) {
    versionResult = {
      ok: false,
      out: '',
      err: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeoutId);
  }

  let dl: number | null = null;
  let up: number | null = null;
  let total: number | null = null;
  let listenPort: number | null = null;

  if (ok && auth !== null && auth.username.length > 0 && auth.password.length > 0) {
    const cookie = await getQbitCookie(url, auth).catch(() => null);
    if (cookie !== null) {
      const stats = await fetchQbitStats(url, cookie);
      if (stats !== null) {
        dl = stats.dl;
        up = stats.up;
        total = stats.total;
        listenPort = stats.listenPort ?? null;
      }
    }
  }

  if (ok) {
    return { name, url, ok: true, version, http: 200, dl, up, total, listenPort };
  }

  const reason = versionResult.ok ? 'not whitelisted' : (versionResult.err ?? (versionResult.out.length > 0 ? versionResult.out : 'unreachable'));
  return { name, url, ok: false, reason, http: 0 };
}

/**
 * Check qBittorrent egress IP
 */
export async function probeQbitEgress(): Promise<QbitEgressProbeResult> {
  const ip = await getEgressIP('qbittorrent').catch(() => '');
  return {
    name: 'qBittorrent egress',
    container: 'qbittorrent',
    ok: ip.length > 0,
    vpnEgress: ip.length > 0 ? ip : '',
  };
}

// ============================================================================
// qBittorrent Helper Functions
// ============================================================================

/**
 * qBittorrent session cookie cache
 * Cookies typically expire after inactivity, so we cache for 10 minutes
 */
interface QbitCookieCache {
  cookie: string;
  expiresAt: number;
  url: string;
}

let qbitCookieCache: QbitCookieCache | null = null;
const COOKIE_CACHE_DURATION_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Login to qBittorrent and get session cookie
 */
async function qbitLogin(url: string, auth: QbitCredentials) {
  const payload = `username=${encodeURIComponent(auth.username)}&password=${encodeURIComponent(auth.password)}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => { controller.abort(); }, 4000);

  try {
    const headers = buildHeaders([
      'Content-Type: application/x-www-form-urlencoded',
      ...qbitHeaders(url),
    ]);

    const response = await fetch(`${url}/api/v2/auth/login`, {
      method: 'POST',
      headers,
      body: payload,
      signal: controller.signal,
    });

    if (!response.ok) return null;

    // Extract SID from Set-Cookie header
    const setCookie = response.headers.get('set-cookie');
    if (setCookie === null) return null;

    const match = /SID=([^;]+)/.exec(setCookie);
    const sid = match?.[1] !== undefined ? match[1].trim() : null;

    // Cache the cookie
    if (sid !== null) {
      qbitCookieCache = {
        cookie: sid,
        expiresAt: Date.now() + COOKIE_CACHE_DURATION_MS,
        url,
      };
    }

    return sid;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Get cached qBittorrent cookie or refresh if expired
 */
async function getQbitCookie(url: string, auth: QbitCredentials) {
  // Check if we have a valid cached cookie for this URL
  if (
    qbitCookieCache !== null &&
    qbitCookieCache.url === url &&
    qbitCookieCache.expiresAt > Date.now()
  ) {
    return qbitCookieCache.cookie;
  }

  // Cache miss or expired - login and cache
  return await qbitLogin(url, auth);
}

async function fetchQbitStats(url: string, cookie: string) {
  const headers = qbitHeaders(url, [`Cookie: SID=${cookie}`]);
  const [transfer, torrents, prefs] = await Promise.all([
    httpGet(`${url}/api/v2/transfer/info`, { headers, timeout: 4 }),
    httpGet(`${url}/api/v2/torrents/info?filter=all`, { headers, timeout: 5 }),
    httpGet(`${url}/api/v2/app/preferences`, { headers, timeout: 4 }),
  ]);

  const dl = transfer.ok ? parseJson(transfer.out, (data) =>
    typeof (data as { dl_info_speed?: unknown }).dl_info_speed === 'number'
      ? (data as { dl_info_speed: number }).dl_info_speed
      : null
  ) : null;

  const up = transfer.ok ? parseJson(transfer.out, (data) =>
    typeof (data as { up_info_speed?: unknown }).up_info_speed === 'number'
      ? (data as { up_info_speed: number }).up_info_speed
      : null
  ) : null;

  const total = torrents.ok ? parseJson(torrents.out, (data) =>
    Array.isArray(data) ? data.length : null
  ) : null;

  const listenPort = prefs.ok ? parseJson(prefs.out, (data) =>
    typeof (data as { listen_port?: unknown }).listen_port === 'number'
      ? (data as { listen_port: number }).listen_port
      : null
  ) : null;

  if (dl === null && up === null && total === null && listenPort === null) {
    return null;
  }

  return { dl, up, total, listenPort };
}
