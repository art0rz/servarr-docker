/**
 * Health probes for qBittorrent
 */

import { getEgressIP, getContainerNetworkThroughput } from '../../docker';
import { type QbitCredentials } from '../../config';
import { httpGet, qbitHeaders, buildHeaders, parseJson } from '../http';
import type {
  QbitProbeResult,
  QbitEgressProbeResult,
  QbitTorrentRate,
} from '../types';

/**
 * Probe qBittorrent (whitelist bypass)
 */
interface QbitProbeOptions {
  includeTorrentRates?: boolean;
}

export async function probeQbit(
  url: string | undefined,
  auth: QbitCredentials | null,
  options: QbitProbeOptions = {}
): Promise<QbitProbeResult> {
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

  // Get network throughput from Docker stats cache (populated by stats stream watcher)
  const networkStats = getContainerNetworkThroughput('qbittorrent');
  if (networkStats !== null) {
    dl = networkStats.downloadBytesPerSec;
    up = networkStats.uploadBytesPerSec;
  }

  // Get additional stats from qBittorrent API if authenticated
  let torrentRates: Array<QbitTorrentRate> = [];

  if (ok && auth !== null && auth.username.length > 0 && auth.password.length > 0) {
    const cookie = await getQbitCookie(url, auth).catch(() => null);
    if (cookie !== null) {
      const stats = await fetchQbitStats(url, cookie, options);
      if (stats !== null) {
        total = stats.total;
        listenPort = stats.listenPort ?? null;
        if (Array.isArray(stats.torrents)) {
          torrentRates = stats.torrents;
        }
      }
    }
  }

  if (ok) {
    return { name, url, ok: true, version, http: 200, dl, up, total, listenPort, torrents: torrentRates };
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

async function fetchQbitStats(url: string, cookie: string, options: QbitProbeOptions) {
  const headers = qbitHeaders(url, [`Cookie: SID=${cookie}`]);
  const [torrents, prefs] = await Promise.all([
    httpGet(`${url}/api/v2/torrents/info?filter=all`, { headers, timeout: 5 }),
    httpGet(`${url}/api/v2/app/preferences`, { headers, timeout: 4 }),
  ]);

  let parsedTorrents: Array<unknown> | null = null;
  if (torrents.ok) {
    parsedTorrents = parseJson(torrents.out, (data) =>
      Array.isArray(data) ? data : null
    );
  }
  const total = parsedTorrents !== null ? parsedTorrents.length : null;

  const listenPort = prefs.ok ? parseJson(prefs.out, (data) =>
    typeof (data as { listen_port?: unknown }).listen_port === 'number'
      ? (data as { listen_port: number }).listen_port
      : null
  ) : null;

  let torrentRates: Array<QbitTorrentRate> = [];
  if (options.includeTorrentRates === true && parsedTorrents !== null) {
    torrentRates = extractTorrentRates(parsedTorrents);
  }

  if (total === null && listenPort === null && torrentRates.length === 0) {
    return null;
  }

  return { total, listenPort, torrents: torrentRates };
}

function extractTorrentRates(data: Array<unknown>): Array<QbitTorrentRate> {
  const entries: Array<QbitTorrentRate> = [];
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue;
    const torrent = item as { hash?: unknown; name?: unknown; dlspeed?: unknown; upspeed?: unknown };
    const hash = typeof torrent.hash === 'string' ? torrent.hash : null;
    const name = typeof torrent.name === 'string' ? torrent.name : null;
    const dlspeed = typeof torrent.dlspeed === 'number' ? Math.max(0, torrent.dlspeed) : 0;
    const upspeed = typeof torrent.upspeed === 'number' ? Math.max(0, torrent.upspeed) : 0;
    if (hash === null) continue;
    entries.push({
      id: hash,
      name: name ?? hash,
      downloadRate: dlspeed,
      uploadRate: upspeed,
    });
  }
  return entries.sort((a, b) => (b.downloadRate + b.uploadRate) - (a.downloadRate + a.uploadRate));
}
