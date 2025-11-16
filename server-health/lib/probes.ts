import { cmd, dockerInspect, dockerEnvMap, getEgressIP, type CommandResult } from './docker.js';
import { loadCrossSeedStats, type QbitCredentials } from './config.js';

interface HttpOptions {
  headers?: string[];
  timeout?: number;
}

function buildHeaderArgs(headers: string[] = []): string {
  return headers
    .filter(Boolean)
    .map(header => `-H ${JSON.stringify(header)}`)
    .join(' ');
}

function arrHeaders(apiKey: string | null): string[] {
  return apiKey !== null ? [`X-Api-Key: ${apiKey}`] : [];
}

function qbitHeaders(baseUrl: string, extras: string[] = []): string[] {
  return [`Referer: ${baseUrl}/`, `Origin: ${baseUrl}`, ...extras];
}

function headerArgsString(headers: string[] = []): string {
  const args = buildHeaderArgs(headers);
  return args.length > 0 ? `${args} ` : '';
}

/**
 * Make a GET request using curl
 */
async function httpGet(url: string, options: HttpOptions = {}): Promise<CommandResult> {
  const timeout = options.timeout ?? 3;
  const headerArgs = buildHeaderArgs(options.headers);
  const headerSegment = headerArgs.length > 0 ? `${headerArgs} ` : '';
  return cmd(`curl -sS -m ${String(timeout)} ${headerSegment}${JSON.stringify(url)}`);
}

/**
 * Make a POST request using curl
 */
async function httpPost(url: string, body: unknown, options: HttpOptions = {}): Promise<CommandResult> {
  const data = JSON.stringify(body);
  const headers = ['Content-Type: application/json', ...(options.headers ?? [])];
  const headerArgs = buildHeaderArgs(headers);
  const timeout = options.timeout ?? 4;
  return cmd(`curl -sS -m ${String(timeout)} ${headerArgs} --data ${JSON.stringify(data)} ${JSON.stringify(url)}`);
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
 * Generic probe for *arr services (Sonarr, Radarr, Prowlarr, Bazarr)
 */
async function probeArrService(name: string, url: string | undefined, headers: string[], apiVersion = 'v3'): Promise<BaseProbeResult> {
  if (url === undefined) return { name, ok: false, reason: 'container not found' };

  const status = await httpGet(`${url}/api/${apiVersion}/system/status`, { headers });
  const ok = status.ok;
  let version = '';

  if (ok) {
    try {
      const parsed = JSON.parse(status.out) as { version?: unknown };
      version = typeof parsed.version === 'string' ? parsed.version : '';
    } catch {
      // Ignore parse errors
    }
  }

  return { name, url, ok, version, http: ok ? 200 : 0 };
}

export interface SonarrProbeResult extends BaseProbeResult {
  queue?: number;
}

/**
 * Probe Sonarr with queue info
 */
export async function probeSonarr(url: string | undefined, apiKey: string | null): Promise<SonarrProbeResult> {
  if (url === undefined) return { name: 'Sonarr', ok: false, reason: 'container not found' };

  const headers = arrHeaders(apiKey);
  const base = await probeArrService('Sonarr', url, headers, 'v3');
  if (!base.ok) return base;

  const queue = await httpGet(`${url}/api/v3/queue?page=1&pageSize=1`, { headers });
  let count = 0;
  try {
    const data = JSON.parse(queue.out) as { totalRecords?: unknown };
    count = typeof data.totalRecords === 'number' ? data.totalRecords : 0;
  } catch {
    // Ignore parse errors
  }

  return { ...base, queue: count };
}

export interface RadarrProbeResult extends BaseProbeResult {
  queue?: number;
}

/**
 * Probe Radarr with queue info
 */
export async function probeRadarr(url: string | undefined, apiKey: string | null): Promise<RadarrProbeResult> {
  if (url === undefined) return { name: 'Radarr', ok: false, reason: 'container not found' };

  const headers = arrHeaders(apiKey);
  const base = await probeArrService('Radarr', url, headers, 'v3');
  if (!base.ok) return base;

  const queue = await httpGet(`${url}/api/v3/queue?page=1&pageSize=1`, { headers });
  let count = 0;
  try {
    const data = JSON.parse(queue.out) as { totalRecords?: unknown };
    count = typeof data.totalRecords === 'number' ? data.totalRecords : 0;
  } catch {
    // Ignore parse errors
  }

  return { ...base, queue: count };
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
  let active = 0;
  try {
    const parsed = JSON.parse(indexers.out) as unknown[];
    active = Array.isArray(parsed) ? parsed.filter(i => (i as { enable?: unknown }).enable === true).length : 0;
  } catch {
    // Ignore parse errors
  }

  return { ...base, indexers: active };
}

export type BazarrProbeResult = BaseProbeResult;

/**
 * Probe Bazarr
 */
export async function probeBazarr(url: string | undefined): Promise<BazarrProbeResult> {
  if (url === undefined) return { name: 'Bazarr', ok: false, reason: 'container not found' };

  const status = await httpGet(`${url}/api/system/status`);
  const ok = status.ok;
  let version = '';

  if (ok) {
    try {
      const parsed = JSON.parse(status.out) as { version?: unknown };
      version = typeof parsed.version === 'string' ? parsed.version : '';
    } catch {
      // Ignore parse errors
    }
  }

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

  const headerArgs = headerArgsString(qbitHeaders(url));
  const versionResult = await cmd(
    `curl -sS -m 3 ${headerArgs}-w "%{http_code}" -o - ${JSON.stringify(url + '/api/v2/app/webapiVersion')}`
  );

  let ok = false;
  let version = '';

  if (versionResult.ok) {
    const body = versionResult.out.slice(0, -3).trim();
    const code = versionResult.out.slice(-3);

    if (code === '200' && !/^Forbidden/i.test(body)) {
      ok = true;
      version = body;
    }
  }

  let dl: number | null = null;
  let up: number | null = null;
  let total: number | null = null;
  let listenPort: number | null = null;

  if (ok && auth !== null && auth.username.length > 0 && auth.password.length > 0) {
    const cookie = await qbitLogin(url, auth).catch(() => null);
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
  let sessions = 0;

  if (ok) {
    try {
      const data = JSON.parse(result.out) as { sessions?: unknown };
      sessions = Array.isArray(data.sessions) ? data.sessions.length : 0;
    } catch {
      // Ignore parse errors
    }
  }

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

  const [healthy, running, forwarded, uiMap, ip] = await Promise.all([
    dockerInspect('.State.Health.Status', name),
    dockerInspect('.State.Running', name),
    cmd(`docker exec ${name} sh -c 'cat /tmp/gluetun/forwarded_port 2>/dev/null || true'`),
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
    forwardedPort: forwarded.ok ? forwarded.out.trim() : '',
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

  // Get logs from last 24 hours using since flag
  const logs = await cmd(`docker logs recyclarr --since 24h 2>&1`);

  if (!logs.ok) {
    return { name, ok: false, reason: 'failed to read logs' };
  }

  // Count errors in last 24h
  const logLines = logs.out.split('\n');
  const errorLines = logLines.filter(line => {
    const lower = line.toLowerCase();
    return lower.includes('[err]') || (lower.includes('error') && !lower.includes('0 error'));
  });
  const errorCount = errorLines.length;

  // Check for success indicators
  const logText = logs.out.toLowerCase();
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

async function qbitLogin(url: string, auth: QbitCredentials): Promise<string | null> {
  const payload = `username=${encodeURIComponent(auth.username)}&password=${encodeURIComponent(auth.password)}`;
  const headers = qbitHeaders(url, ['Content-Type: application/x-www-form-urlencoded']);
  const command = `curl -sS -m 4 ${headerArgsString(headers)}-D - -o /dev/null --data ${JSON.stringify(payload)} ${JSON.stringify(url + '/api/v2/auth/login')}`;
  const response = await cmd(command);
  if (!response.ok) return null;

  const match = /set-cookie:\s*SID=([^;]+)/i.exec(response.out);
  const sid = match?.[1] !== undefined ? match[1].trim() : null;
  return sid;
}

interface QbitStats {
  dl: number | null;
  up: number | null;
  total: number | null;
  listenPort: number | null;
}

async function fetchQbitStats(url: string, cookie: string): Promise<QbitStats | null> {
  const headers = qbitHeaders(url, [`Cookie: SID=${cookie}`]);
  const [transfer, torrents, prefs] = await Promise.all([
    httpGet(`${url}/api/v2/transfer/info`, { headers, timeout: 4 }),
    httpGet(`${url}/api/v2/torrents/info?filter=all`, { headers, timeout: 5 }),
    httpGet(`${url}/api/v2/app/preferences`, { headers, timeout: 4 }),
  ]);

  let dl: number | null = null;
  let up: number | null = null;
  let total: number | null = null;
  let listenPort: number | null = null;

  if (transfer.ok) {
    try {
      const data = JSON.parse(transfer.out) as { dlspeed?: unknown; upspeed?: unknown };
      dl = typeof data.dlspeed === 'number' ? data.dlspeed : null;
      up = typeof data.upspeed === 'number' ? data.upspeed : null;
    } catch {
      // Ignore parse errors
    }
  }

  if (torrents.ok) {
    try {
      const list = JSON.parse(torrents.out) as unknown;
      total = Array.isArray(list) ? list.length : null;
    } catch {
      // Ignore parse errors
    }
  }

  if (prefs.ok) {
    try {
      const pref = JSON.parse(prefs.out) as { listen_port?: unknown };
      if (typeof pref.listen_port === 'number') {
        listenPort = pref.listen_port;
      }
    } catch {
      // Ignore parse errors
    }
  }

  if (dl === null && up === null && total === null && listenPort === null) {
    return null;
  }

  return { dl, up, total, listenPort };
}

function summarizeNames(items: unknown[]): string {
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

async function checkArrDownloadClients(label: string, url: string | undefined, apiKey: string | null): Promise<CheckResult> {
  if (url === undefined) return { name: label, ok: false, detail: 'service URL unavailable' };
  if (apiKey === null) return { name: label, ok: false, detail: 'API key unavailable' };

  const headers = arrHeaders(apiKey);
  const response = await httpGet(`${url}/api/v3/downloadclient`, { headers, timeout: 4 });
  if (!response.ok) {
    return { name: label, ok: false, detail: response.err ?? (response.out.length > 0 ? response.out : 'request failed') };
  }

  try {
    const clients = JSON.parse(response.out) as unknown[];
    const enabled = Array.isArray(clients) ? clients.filter(client => (client as { enable?: unknown }).enable === true) : [];
    const detail = enabled.length > 0
      ? `enabled: ${summarizeNames(enabled)}`
      : 'no enabled clients';

    return {
      name: label,
      ok: enabled.length > 0,
      detail,
    };
  } catch {
    return { name: label, ok: false, detail: 'failed to parse response' };
  }
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

  try {
    const indexers = JSON.parse(response.out) as unknown[];
    const enabled = Array.isArray(indexers) ? indexers.filter(indexer => (indexer as { enable?: unknown }).enable === true) : [];
    const detail = enabled.length > 0
      ? `enabled: ${summarizeNames(enabled)}`
      : 'no enabled indexers';

    return {
      name,
      ok: enabled.length > 0,
      detail,
    };
  } catch {
    return { name, ok: false, detail: 'failed to parse response' };
  }
}

/**
 * Check pf-sync heartbeat (stub - not yet implemented)
 */
export function checkPfSyncHeartbeat(): Promise<CheckResult> {
  return Promise.resolve({ name: 'pf-sync heartbeat', ok: true, detail: 'not implemented' });
}

/**
 * Check disk usage (stub - not yet implemented)
 */
export function checkDiskUsage(): Promise<CheckResult> {
  return Promise.resolve({ name: 'disk usage', ok: true, detail: 'not implemented' });
}

/**
 * Check image age (stub - not yet implemented)
 */
export function checkImageAge(): Promise<CheckResult> {
  return Promise.resolve({ name: 'image age', ok: true, detail: 'not implemented' });
}
