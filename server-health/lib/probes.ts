import { dockerInspect, dockerEnvMap, getEgressIP, getContainerLogs, getContainerImageAge, getCachedGluetunPort } from './docker';
import { loadCrossSeedStats, MEDIA_DIR, type QbitCredentials } from './config';

interface HttpOptions {
  headers?: Array<string>;
  timeout?: number;
}

function arrHeaders(apiKey: string | null) {
  return apiKey !== null ? [`X-Api-Key: ${apiKey}`] : [];
}

function qbitHeaders(baseUrl: string, extras: Array<string> = []) {
  return [`Referer: ${baseUrl}/`, `Origin: ${baseUrl}`, ...extras];
}

/**
 * Convert header array to Headers object
 */
function buildHeaders(headerList: Array<string> = []) {
  const headers = new Headers();
  for (const header of headerList) {
    const separatorIndex = header.indexOf(':');
    if (separatorIndex > 0) {
      const key = header.slice(0, separatorIndex).trim();
      const value = header.slice(separatorIndex + 1).trim();
      headers.set(key, value);
    }
  }
  return headers;
}

/**
 * Core HTTP request function shared by GET and POST
 */
async function httpRequest(
  url: string,
  method: 'GET' | 'POST',
  options: HttpOptions = {},
  body?: string
) {
  const timeout = (options.timeout ?? (method === 'GET' ? 3 : 4)) * 1000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => { controller.abort(); }, timeout);

  try {
    const headers = buildHeaders(options.headers);

    const response = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: controller.signal,
    });

    const text = await response.text();

    if (response.ok) {
      return { ok: true, out: text };
    } else {
      return { ok: false, out: '', err: text };
    }
  } catch (error) {
    return {
      ok: false,
      out: '',
      err: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Make a GET request using native fetch
 */
async function httpGet(url: string, options: HttpOptions = {}) {
  return httpRequest(url, 'GET', options);
}

/**
 * Make a POST request using native fetch
 */
async function httpPost(url: string, body: unknown, options: HttpOptions = {}) {
  const headers = ['Content-Type: application/json', ...(options.headers ?? [])];
  return httpRequest(url, 'POST', { ...options, headers }, JSON.stringify(body));
}

interface BaseProbeResult {
  name: string;
  url?: string;
  ok: boolean;
  reason?: string;
  version?: string;
  http?: number;
}

/**
 * Safely parse JSON and extract a typed value
 */
function parseJson<T>(json: string, extractor: (data: unknown) => T | null): T | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    return extractor(parsed);
  } catch {
    return null;
  }
}

/**
 * Generic probe for *arr services (Sonarr, Radarr, Prowlarr, Bazarr)
 */
async function probeArrService(name: string, url: string | undefined, headers: Array<string>, apiVersion = 'v3') {
  if (url === undefined) return { name, ok: false, reason: 'container not found' };

  const status = await httpGet(`${url}/api/${apiVersion}/system/status`, { headers });
  const ok = status.ok;
  const version = ok ? parseJson(status.out, (data) =>
    typeof (data as { version?: unknown }).version === 'string'
      ? (data as { version: string }).version
      : null
  ) ?? '' : '';

  return { name, url, ok, version, http: ok ? 200 : 0 };
}

export interface ArrQueueProbeResult extends BaseProbeResult {
  queue?: number;
}

export type SonarrProbeResult = ArrQueueProbeResult;
export type RadarrProbeResult = ArrQueueProbeResult;

/**
 * Generic probe for *arr services with queue info (Sonarr/Radarr)
 */
async function probeArrWithQueue(name: string, url: string | undefined, apiKey: string | null, apiVersion = 'v3'): Promise<ArrQueueProbeResult> {
  if (url === undefined) return { name, ok: false, reason: 'container not found' };

  const headers = arrHeaders(apiKey);
  const base = await probeArrService(name, url, headers, apiVersion);
  if (!base.ok) return base;

  const queue = await httpGet(`${url}/api/${apiVersion}/queue?page=1&pageSize=1`, { headers });
  const count = parseJson(queue.out, (data) =>
    typeof (data as { totalRecords?: unknown }).totalRecords === 'number'
      ? (data as { totalRecords: number }).totalRecords
      : null
  ) ?? 0;

  return { ...base, queue: count };
}

/**
 * Probe Sonarr with queue info
 */
export async function probeSonarr(url: string | undefined, apiKey: string | null): Promise<SonarrProbeResult> {
  return probeArrWithQueue('Sonarr', url, apiKey, 'v3');
}

/**
 * Probe Radarr with queue info
 */
export async function probeRadarr(url: string | undefined, apiKey: string | null): Promise<RadarrProbeResult> {
  return probeArrWithQueue('Radarr', url, apiKey, 'v3');
}

export interface ProwlarrProbeResult extends BaseProbeResult {
  indexers?: number;
}

/**
 * Probe Prowlarr with indexer count
 */
export async function probeProwlarr(url: string | undefined, apiKey: string | null): Promise<ProwlarrProbeResult> {
  if (url === undefined) return { name: 'Prowlarr', ok: false, reason: 'container not found' };

  const headers = arrHeaders(apiKey);
  const base = await probeArrService('Prowlarr', url, headers, 'v1');
  if (!base.ok) return base;

  const indexers = await httpGet(`${url}/api/v1/indexer`, { headers });
  const active = parseJson(indexers.out, (data) =>
    Array.isArray(data)
      ? data.filter(i => (i as { enable?: unknown }).enable === true).length
      : null
  ) ?? 0;

  return { ...base, indexers: active };
}

export type BazarrProbeResult = BaseProbeResult;

/**
 * Probe Bazarr (uses different header name than *arr services)
 */
export async function probeBazarr(url: string | undefined, apiKey: string | null): Promise<BazarrProbeResult> {
  if (url === undefined) return { name: 'Bazarr', ok: false, reason: 'container not found' };

  const headers = apiKey !== null ? [`X-API-KEY: ${apiKey}`] : [];
  const status = await httpGet(`${url}/api/system/status`, { headers });
  const ok = status.ok;
  const version = ok ? parseJson(status.out, (data) =>
    typeof (data as { version?: unknown }).version === 'string'
      ? (data as { version: string }).version
      : null
  ) ?? '' : '';

  return { name: 'Bazarr', url, ok, version, http: ok ? 200 : 0 };
}

export interface QbitProbeResult extends BaseProbeResult {
  dl?: number | null;
  up?: number | null;
  total?: number | null;
  listenPort?: number | null;
}

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

export interface FlareProbeResult extends BaseProbeResult {
  sessions?: number;
}

/**
 * Probe FlareSolverr
 */
export async function probeFlare(url: string | undefined): Promise<FlareProbeResult> {
  if (url === undefined) return { name: 'FlareSolverr', ok: false, reason: 'container not found' };

  const result = await httpPost(`${url}/v1`, { cmd: 'sessions.list' });
  const ok = result.ok;
  const sessions = ok ? parseJson(result.out, (data) =>
    Array.isArray((data as { sessions?: unknown }).sessions)
      ? (data as { sessions: unknown[] }).sessions.length
      : null
  ) ?? 0 : 0;

  return { name: 'FlareSolverr', url, ok, sessions, http: ok ? 200 : 0 };
}

export interface CrossSeedProbeResult extends BaseProbeResult {
  lastRun?: string | null;
  torrentsAdded?: number | null;
}

/**
 * Probe Cross-Seed
 */
export async function probeCrossSeed(url: string | undefined): Promise<CrossSeedProbeResult> {
  if (url === undefined) return { name: 'Cross-Seed', ok: false, reason: 'container not found' };

  const result = await httpGet(`${url}/api/ping`);
  const ok = result.ok;

  if (ok) {
    const stats = await loadCrossSeedStats().catch(() => null);
    return {
      name: 'Cross-Seed',
      url,
      ok: true,
      version: '',
      http: 200,
      lastRun: stats?.lastTimestamp ?? null,
      torrentsAdded: typeof stats?.added === 'number' ? stats.added : null,
    };
  }

  return { name: 'Cross-Seed', url, ok: false, http: 0 };
}

export interface GluetunProbeResult {
  name: string;
  container: string;
  ok: boolean;
  running: boolean;
  healthy: string | null;
  vpnEgress: string;
  forwardedPort: string;
  pfExpected: boolean;
  uiHostPort: string;
}

/**
 * Probe Gluetun VPN gateway
 */
export async function probeGluetun(): Promise<GluetunProbeResult> {
  const name = 'gluetun';
  const env = await dockerEnvMap(name);
  const pfEnv = env['VPN_PORT_FORWARDING'] ?? env['PORT_FORWARDING'] ?? '';
  const pfExpected = pfEnv.toLowerCase() === 'on';

  // Get cached forwarded port (no need to exec into container)
  const forwardedPort = getCachedGluetunPort();

  const [healthy, running, uiMap, ip] = await Promise.all([
    dockerInspect('.State.Health.Status', name),
    dockerInspect('.State.Running', name),
    dockerInspect(`.NetworkSettings.Ports["8080/tcp"]`, name),
    getEgressIP(name).catch(() => ''),
  ]);

  const healthyStr = typeof healthy === 'string' ? healthy : null;
  const runningBool = running === true;

  interface PortMapping {
    HostPort?: unknown;
  }
  const uiHostPort = Array.isArray(uiMap) && uiMap[0] !== undefined
    ? (typeof (uiMap[0] as PortMapping).HostPort === 'string' ? (uiMap[0] as PortMapping).HostPort as string : '')
    : '';

  return {
    name: 'Gluetun',
    container: name,
    ok: runningBool && healthyStr === 'healthy',
    running: runningBool,
    healthy: healthyStr,
    vpnEgress: ip.length > 0 ? ip : '',
    forwardedPort,
    pfExpected,
    uiHostPort: uiHostPort.length > 0 ? uiHostPort : '',
  };
}

export interface QbitEgressProbeResult {
  name: string;
  container: string;
  ok: boolean;
  vpnEgress: string;
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

export interface RecyclarrProbeResult extends BaseProbeResult {
  detail?: string;
}

/**
 * Probe Recyclarr by checking Docker logs
 */
export async function probeRecyclarr(): Promise<RecyclarrProbeResult> {
  const name = 'Recyclarr';

  // Check if container is running
  const running = await dockerInspect('.State.Running', 'recyclarr');
  if (running !== true) {
    return { name, ok: false, reason: 'container not running' };
  }

  // Get logs from last 24 hours
  const logsText = await getContainerLogs('recyclarr');

  if (logsText.length === 0) {
    return { name, ok: false, reason: 'failed to read logs' };
  }

  // Count errors in last 24h
  const logLines = logsText.split('\n');
  const errorLines = logLines.filter(line => {
    const lower = line.toLowerCase();
    return lower.includes('[err]') || (lower.includes('error') && !lower.includes('0 error'));
  });
  const errorCount = errorLines.length;

  // Check for success indicators
  const logText = logsText.toLowerCase();
  const hasSuccess = logText.includes('completed successfully') ||
                     logText.includes('[inf]') ||
                     logText.includes('starting cron');

  // Consider healthy if running with success indicators and no errors
  const ok = hasSuccess && errorCount === 0;

  return {
    name,
    ok,
    version: '',
    http: 0,
    detail: errorCount === 0 ? 'no errors (24h)' : `${String(errorCount)} error${errorCount !== 1 ? 's' : ''} (24h)`,
  };
}

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

function summarizeNames(items: Array<unknown>): string {
  return items
    .map(item => (item !== null && typeof item === 'object' && 'name' in item && typeof item.name === 'string' ? item.name : null))
    .filter((name): name is string => name !== null)
    .join(', ');
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

async function checkArrDownloadClients(label: string, url: string | undefined, apiKey: string | null) {
  if (url === undefined) return { name: label, ok: false, detail: 'service URL unavailable' };
  if (apiKey === null) return { name: label, ok: false, detail: 'API key unavailable' };

  const headers = arrHeaders(apiKey);
  const response = await httpGet(`${url}/api/v3/downloadclient`, { headers, timeout: 4 });
  if (!response.ok) {
    return { name: label, ok: false, detail: response.err ?? (response.out.length > 0 ? response.out : 'request failed') };
  }

  const enabled = parseJson(response.out, (data) =>
    Array.isArray(data)
      ? data.filter(client => (client as { enable?: unknown }).enable === true)
      : null
  );

  if (enabled === null) {
    return { name: label, ok: false, detail: 'failed to parse response' };
  }

  const detail = enabled.length > 0
    ? `enabled: ${summarizeNames(enabled)}`
    : 'no enabled clients';

  return {
    name: label,
    ok: enabled.length > 0,
    detail,
  };
}

export async function checkSonarrDownloadClients(url: string | undefined, apiKey: string | null): Promise<CheckResult> {
  return checkArrDownloadClients('Sonarr download clients', url, apiKey);
}

export async function checkRadarrDownloadClients(url: string | undefined, apiKey: string | null): Promise<CheckResult> {
  return checkArrDownloadClients('Radarr download clients', url, apiKey);
}

export async function checkProwlarrIndexers(url: string | undefined, apiKey: string | null): Promise<CheckResult> {
  const name = 'Prowlarr indexers';
  if (url === undefined) return { name, ok: false, detail: 'service URL unavailable' };
  if (apiKey === null) return { name, ok: false, detail: 'API key unavailable' };

  const headers = arrHeaders(apiKey);
  const response = await httpGet(`${url}/api/v1/indexer`, { headers, timeout: 4 });
  if (!response.ok) {
    return { name, ok: false, detail: response.err ?? (response.out.length > 0 ? response.out : 'request failed') };
  }

  const enabled = parseJson(response.out, (data) =>
    Array.isArray(data)
      ? data.filter(indexer => (indexer as { enable?: unknown }).enable === true)
      : null
  );

  if (enabled === null) {
    return { name, ok: false, detail: 'failed to parse response' };
  }

  const detail = enabled.length > 0
    ? `enabled: ${summarizeNames(enabled)}`
    : 'no enabled indexers';

  return {
    name,
    ok: enabled.length > 0,
    detail,
  };
}

/**
 * Check pf-sync heartbeat - verify port forwarding sync is working
 */
export async function checkPfSyncHeartbeat() {
  const name = 'pf-sync heartbeat';

  // Check if container is running
  const running = await dockerInspect('.State.Running', 'pf-sync');
  if (running !== true) {
    return { name, ok: false, detail: 'container not running' };
  }

  // Check logs for recent activity (last 5 minutes)
  const fiveMinutesAgo = Math.floor(Date.now() / 1000 - 300);
  const logs = await getContainerLogs('pf-sync', String(fiveMinutesAgo));

  if (logs.length === 0) {
    return { name, ok: false, detail: 'no recent activity (5m)' };
  }

  // Look for successful port updates or error messages
  const hasError = /error|fail|fatal/i.test(logs);
  const hasSuccess = /updated|synced|forwarded|success/i.test(logs);

  if (hasError) {
    return { name, ok: false, detail: 'errors in recent logs' };
  }

  if (hasSuccess) {
    return { name, ok: true, detail: 'active (recent sync detected)' };
  }

  // No errors but also no explicit success - container is running but quiet
  return { name, ok: true, detail: 'running (no recent activity)' };
}

/**
 * Check disk usage for important volumes
 */
export async function checkDiskUsage() {
  const name = 'disk usage (media)';

  try {
    // Check disk usage on the media directory
    const { statfs } = await import('node:fs/promises');
    const stats = await statfs(MEDIA_DIR);

    const total = stats.blocks * stats.bsize;
    const available = stats.bavail * stats.bsize;
    const used = total - available;
    const usedPercent = Math.round((used / total) * 100);

    const totalGB = (total / 1024 / 1024 / 1024).toFixed(1);
    const usedGB = (used / 1024 / 1024 / 1024).toFixed(1);
    const availableGB = (available / 1024 / 1024 / 1024).toFixed(1);
    const detail = `${String(usedPercent)}% used (${usedGB}GB / ${totalGB}GB, ${availableGB}GB free)`;

    // Warn if over 85%, error if over 95%
    if (usedPercent >= 95) {
      return { name, ok: false, detail: `${detail} - critical` };
    } else if (usedPercent >= 85) {
      return { name, ok: false, detail: `${detail} - warning` };
    }

    return { name, ok: true, detail };
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    return { name, ok: false, detail: `failed to check: ${err}` };
  }
}

/**
 * Check Docker image age for key containers
 */
export async function checkImageAge() {
  const name = 'image age';

  // Check a few key containers
  const containersToCheck = ['sonarr', 'radarr', 'qbittorrent', 'gluetun'];

  try {
    const results = await Promise.all(
      containersToCheck.map(async (containerName) => {
        const created = await getContainerImageAge(containerName);
        if (created === null) return null;

        const createdDate = new Date(created);
        const ageMs = Date.now() - createdDate.getTime();
        const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

        return { containerName, ageDays };
      })
    );

    const validResults = results.filter((r): r is { containerName: string; ageDays: number } => r !== null);

    if (validResults.length === 0) {
      return { name, ok: false, detail: 'unable to check any images' };
    }

    // Find oldest image
    const oldest = validResults.reduce((max, r) => (r.ageDays > max.ageDays ? r : max));

    // Warn if any image is > 90 days old
    const hasOld = validResults.some(r => r.ageDays > 90);

    const detail = `oldest: ${oldest.containerName} (${String(oldest.ageDays)}d)`;

    if (hasOld) {
      return { name, ok: false, detail: `${detail} - update recommended` };
    }

    return { name, ok: true, detail };
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    return { name, ok: false, detail: `failed to check: ${err}` };
  }
}
