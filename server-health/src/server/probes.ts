import {
  cmd,
  dockerEnvMap,
  dockerInspect,
  getDiskUsage as dockerDiskUsage,
  getEgressIP,
  getFileMtime,
  getImageCreationDate
} from './docker.js';
import { loadCrossSeedStats } from './config.js';

interface OptionalCredentials {
  username?: string;
  password?: string;
}

interface RequiredCredentials {
  username: string;
  password: string;
}

interface RequestOptions {
  headers?: string[];
  timeout?: number;
}

interface QbitTransferStats {
  dl: number | null;
  up: number | null;
  total: number | null;
  listenPort: number | null;
}

function buildHeaderArgs(headers: string[] = []): string {
  return headers
    .filter(Boolean)
    .map(header => `-H ${JSON.stringify(header)}`)
    .join(' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

interface ToggleEntry {
  name?: string;
  enable?: boolean;
}

function collectToggleEntries(value: unknown): ToggleEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is ToggleEntry => isRecord(entry));
}

interface PortBinding {
  HostPort?: string;
}

function extractHostPort(value: unknown): string {
  if (!isRecord(value)) return '';
  const hostPort = (value as PortBinding).HostPort;
  return typeof hostPort === 'string' ? hostPort : '';
}

function arrHeaders(apiKey?: string | null): string[] {
  return apiKey ? [`X-Api-Key: ${apiKey}`] : [];
}

function qbitHeaders(baseUrl: string, extras: string[] = []): string[] {
  return [`Referer: ${baseUrl}/`, `Origin: ${baseUrl}`, ...extras];
}

function hasCredentials(auth?: OptionalCredentials): auth is RequiredCredentials {
  return typeof auth?.username === 'string' && typeof auth.password === 'string';
}

async function httpGet(url: string, options: RequestOptions = {}) {
  const timeout = String(options.timeout ?? 3);
  const headerSegment = buildHeaderArgs(options.headers);
  const prefix = headerSegment ? `${headerSegment} ` : '';
  return cmd(`curl -sS -m ${timeout} ${prefix}${JSON.stringify(url)}`);
}

async function httpPost(url: string, body: Record<string, unknown>, options: RequestOptions = {}) {
  const data = JSON.stringify(body);
  const headers = ['Content-Type: application/json', ...(options.headers ?? [])];
  const headerSegment = buildHeaderArgs(headers);
  const prefix = headerSegment ? `${headerSegment} ` : '';
  const timeout = String(options.timeout ?? 4);
  return cmd(`curl -sS -m ${timeout} ${prefix}--data ${JSON.stringify(data)} ${JSON.stringify(url)}`);
}

export interface ServiceResult {
  name: string;
  ok: boolean;
  url?: string;
  version?: string;
  http?: number;
  reason?: string;
  queue?: number;
  indexers?: number;
  sessions?: number;
  dl?: number | null;
  up?: number | null;
  total?: number | null;
  listenPort?: number | null;
  lastRun?: string | null;
  torrentsAdded?: number | null;
  detail?: string;
  forwardedPort?: string;
  pfExpected?: boolean;
  vpnEgress?: string;
  running?: boolean;
  healthy?: string | null;
  uiHostPort?: string;
  container?: string;
}

async function probeArrService(name: string, url: string, headers: string[] = [], apiVersion = 'v3'): Promise<ServiceResult> {
  const status = await httpGet(`${url}/api/${apiVersion}/system/status`, { headers });
  const ok = status.ok;
  let version = '';

  if (ok) {
    const payload = safeParse(status.out);
    if (isRecord(payload)) {
      const parsedVersion = payload.version;
      if (typeof parsedVersion === 'string') {
        version = parsedVersion;
      }
    }
  }

  return { name, url, ok, version, http: ok ? 200 : 0 };
}

export async function probeSonarr(url?: string, apiKey?: string | null): Promise<ServiceResult> {
  if (!url) return { name: 'Sonarr', ok: false, reason: 'container not found' };
  const headers = arrHeaders(apiKey);
  const base = await probeArrService('Sonarr', url, headers, 'v3');
  if (!base.ok) return base;

  const queue = await httpGet(`${url}/api/v3/queue?page=1&pageSize=1`, { headers });
  let count = 0;
  const queueData = safeParse(queue.out);
  if (isRecord(queueData) && typeof queueData.totalRecords === 'number') {
    count = queueData.totalRecords;
  }

  return { ...base, queue: count };
}

export async function probeRadarr(url?: string, apiKey?: string | null): Promise<ServiceResult> {
  if (!url) return { name: 'Radarr', ok: false, reason: 'container not found' };
  const headers = arrHeaders(apiKey);
  const base = await probeArrService('Radarr', url, headers, 'v3');
  if (!base.ok) return base;

  const queue = await httpGet(`${url}/api/v3/queue?page=1&pageSize=1`, { headers });
  let count = 0;
  const queueData = safeParse(queue.out);
  if (isRecord(queueData) && typeof queueData.totalRecords === 'number') {
    count = queueData.totalRecords;
  }

  return { ...base, queue: count };
}

export async function probeProwlarr(url?: string, apiKey?: string | null): Promise<ServiceResult> {
  if (!url) return { name: 'Prowlarr', ok: false, reason: 'container not found' };
  const headers = arrHeaders(apiKey);
  const base = await probeArrService('Prowlarr', url, headers, 'v1');
  if (!base.ok) return base;

  const indexers = await httpGet(`${url}/api/v1/indexer`, { headers });
  let active = 0;
  const indexerData = collectToggleEntries(safeParse(indexers.out));
  active = indexerData.filter(entry => entry.enable === true).length;

  return { ...base, indexers: active };
}

export async function probeBazarr(url?: string): Promise<ServiceResult> {
  if (!url) return { name: 'Bazarr', ok: false, reason: 'container not found' };

  const status = await httpGet(`${url}/api/system/status`);
  const ok = status.ok;
  let version = '';

  if (ok) {
    const payload = safeParse(status.out);
    if (isRecord(payload)) {
      const parsedVersion = payload.version;
      if (typeof parsedVersion === 'string') {
        version = parsedVersion;
      }
    }
  }

  return { name: 'Bazarr', url, ok, version, http: ok ? 200 : 0 };
}

export async function probeQbit(url?: string, auth?: OptionalCredentials): Promise<ServiceResult> {
  const name = 'qBittorrent';
  if (!url) return { name, ok: false, reason: 'container not found' };

  const headerArgs = buildHeaderArgs(qbitHeaders(url));
  const prefix = headerArgs ? `${headerArgs} ` : '';
  const versionResult = await cmd(
    `curl -sS -m 3 ${prefix}-w "%{http_code}" -o - ${JSON.stringify(url + '/api/v2/app/webapiVersion')}`
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

  if (ok && hasCredentials(auth)) {
    const cookie = await qbitLogin(url, auth).catch(() => null);
    if (cookie) {
      const stats = await fetchQbitStats(url, cookie);
      if (stats) {
        dl = stats.dl;
        up = stats.up;
        total = stats.total;
        listenPort = stats.listenPort;
      }
    }
  }

  if (ok) {
    return { name, url, ok: true, version, http: 200, dl, up, total, listenPort };
  }

  const errDetail = typeof versionResult.err === 'string' && versionResult.err !== '' ? versionResult.err : null;
  const outDetail = versionResult.out.trim() === '' ? 'unreachable' : versionResult.out;
  const reason = versionResult.ok ? 'not whitelisted' : (errDetail ?? outDetail);
  return { name, url, ok: false, reason, http: 0 };
}

export async function probeFlare(url?: string): Promise<ServiceResult> {
  if (!url) return { name: 'FlareSolverr', ok: false, reason: 'container not found' };

  const result = await httpPost(`${url}/v1`, { cmd: 'sessions.list' });
  const ok = result.ok;
  let sessions = 0;

  if (ok) {
    const payload = safeParse(result.out);
    if (isRecord(payload) && Array.isArray(payload.sessions)) {
      sessions = payload.sessions.length;
    }
  }

  return { name: 'FlareSolverr', url, ok, sessions, http: ok ? 200 : 0 };
}

export async function probeCrossSeed(url?: string): Promise<ServiceResult> {
  if (!url) return { name: 'Cross-Seed', ok: false, reason: 'container not found' };

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
      torrentsAdded: typeof stats?.added === 'number' ? stats.added : null
    };
  }

  return { name: 'Cross-Seed', url, ok: false, http: 0 };
}

export async function probeGluetun(): Promise<ServiceResult> {
  const env = await dockerEnvMap('gluetun');
  const pfRaw = env.VPN_PORT_FORWARDING && env.VPN_PORT_FORWARDING !== '' ? env.VPN_PORT_FORWARDING : env.PORT_FORWARDING;
  const pfExpected = (pfRaw ?? '').toLowerCase() === 'on';

  const [healthy, running, forwarded, uiMap, ip] = await Promise.all([
    dockerInspect('.State.Health.Status', 'gluetun'),
    dockerInspect('.State.Running', 'gluetun'),
    cmd('docker exec gluetun sh -c \'cat /tmp/gluetun/forwarded_port 2>/dev/null || true\''),
    dockerInspect('.NetworkSettings.Ports["8080/tcp"]', 'gluetun'),
    getEgressIP('gluetun').catch(() => '')
  ]);

  const healthyStatus = typeof healthy === 'string' ? healthy : null;
  const runningStatus = running === true;
  const uiHostPort = extractHostPort(Array.isArray(uiMap) ? uiMap[0] : null);

  return {
    name: 'Gluetun',
    container: 'gluetun',
    ok: runningStatus && healthyStatus === 'healthy',
    running: runningStatus,
    healthy: healthyStatus,
    vpnEgress: ip,
    forwardedPort: forwarded.ok ? forwarded.out.trim() : '',
    pfExpected,
    uiHostPort
  };
}

export async function probeQbitEgress(): Promise<ServiceResult> {
  const ip = await getEgressIP('qbittorrent').catch(() => '');
  return {
    name: 'qBittorrent egress',
    container: 'qbittorrent',
    ok: !!ip,
    vpnEgress: ip
  };
}

export async function probeRecyclarr(): Promise<ServiceResult> {
  const name = 'Recyclarr';
  const running = await dockerInspect('.State.Running', 'recyclarr');
  if (running !== true) {
    return { name, ok: false, reason: 'container not running' };
  }

  const logs = await cmd('docker logs recyclarr --since 24h 2>&1');
  if (!logs.ok) {
    return { name, ok: false, reason: 'failed to read logs' };
  }

  const logLines = logs.out.split('\n');
  const errorLines = logLines.filter((line) => {
    const lower = line.toLowerCase();
    return lower.includes('[err]') || (lower.includes('error') && !lower.includes('0 error'));
  });
  const errorCount = errorLines.length;

  const logText = logs.out.toLowerCase();
  const hasSuccess
    = logText.includes('completed successfully') || logText.includes('[inf]') || logText.includes('starting cron');

  const ok = hasSuccess && errorCount === 0;

  return {
    name,
    ok,
    version: '',
    http: 0,
    detail: errorCount === 0 ? 'no errors (24h)' : `${String(errorCount)} error${errorCount !== 1 ? 's' : ''} (24h)`
  };
}

async function qbitLogin(url: string, auth: RequiredCredentials): Promise<string | null> {
  const payload = `username=${encodeURIComponent(auth.username)}&password=${encodeURIComponent(auth.password)}`;
  const headers = qbitHeaders(url, ['Content-Type: application/x-www-form-urlencoded']);
  const headerSegment = buildHeaderArgs(headers);
  const prefix = headerSegment ? `${headerSegment} ` : '';
  const command = `curl -sS -m 4 ${prefix}-D - -o /dev/null --data ${JSON.stringify(payload)} ${JSON.stringify(
    url + '/api/v2/auth/login'
  )}`;
  const response = await cmd(command);
  if (!response.ok) return null;

  const match = /set-cookie:\s*SID=([^;]+)/i.exec(response.out);
  return match ? match[1].trim() : null;
}

async function fetchQbitStats(url: string, cookie: string): Promise<QbitTransferStats | null> {
  const headers = qbitHeaders(url, [`Cookie: SID=${cookie}`]);
  const [transfer, torrents, prefs] = await Promise.all([
    httpGet(`${url}/api/v2/transfer/info`, { headers, timeout: 4 }),
    httpGet(`${url}/api/v2/torrents/info?filter=all`, { headers, timeout: 5 }),
    httpGet(`${url}/api/v2/app/preferences`, { headers, timeout: 4 })
  ]);

  let dl: number | null = null;
  let up: number | null = null;
  let total: number | null = null;
  let listenPort: number | null = null;

  if (transfer.ok) {
    const data = safeParse(transfer.out);
    if (isRecord(data)) {
      const dlSpeed = data.dlspeed;
      const upSpeed = data.upspeed;
      dl = typeof dlSpeed === 'number' ? dlSpeed : null;
      up = typeof upSpeed === 'number' ? upSpeed : null;
    }
  }

  if (torrents.ok) {
    const list = safeParse(torrents.out);
    total = Array.isArray(list) ? list.length : null;
  }

  if (prefs.ok) {
    const pref = safeParse(prefs.out);
    if (isRecord(pref) && typeof pref.listen_port === 'number') {
      listenPort = pref.listen_port;
    }
  }

  if (dl === null && up === null && total === null && listenPort === null) {
    return null;
  }

  return { dl, up, total, listenPort };
}

function summarizeNames(items: ToggleEntry[]): string {
  return items
    .map(item => item.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
    .join(', ');
}

async function checkArrDownloadClients(label: string, url?: string, apiKey?: string | null) {
  if (!url) return { name: label, ok: false, detail: 'service URL unavailable' };
  if (!apiKey) return { name: label, ok: false, detail: 'API key unavailable' };

  const headers = arrHeaders(apiKey);
  const response = await httpGet(`${url}/api/v3/downloadclient`, { headers, timeout: 4 });
  if (!response.ok) {
    const detail = response.err ?? (response.out === '' ? 'request failed' : response.out);
    return { name: label, ok: false, detail };
  }

  const parsed = safeParse(response.out);
  if (!Array.isArray(parsed)) {
    return { name: label, ok: false, detail: 'failed to parse response' };
  }

  const clients = collectToggleEntries(parsed);
  const enabled = clients.filter(client => client.enable === true);
  const detail = enabled.length ? `enabled: ${summarizeNames(enabled)}` : 'no enabled clients';

  return {
    name: label,
    ok: enabled.length > 0,
    detail
  };
}

export function checkSonarrDownloadClients(url?: string, apiKey?: string | null) {
  return checkArrDownloadClients('Sonarr download clients', url, apiKey);
}

export function checkRadarrDownloadClients(url?: string, apiKey?: string | null) {
  return checkArrDownloadClients('Radarr download clients', url, apiKey);
}

export async function checkProwlarrIndexers(url?: string, apiKey?: string | null) {
  const name = 'Prowlarr indexers';
  if (!url) return { name, ok: false, detail: 'service URL unavailable' };
  if (!apiKey) return { name, ok: false, detail: 'API key unavailable' };

  const headers = arrHeaders(apiKey);
  const response = await httpGet(`${url}/api/v1/indexer`, { headers, timeout: 4 });
  if (!response.ok) {
    const detail = response.err ?? (response.out === '' ? 'request failed' : response.out);
    return { name, ok: false, detail };
  }

  const parsed = safeParse(response.out);
  if (!Array.isArray(parsed)) {
    return { name, ok: false, detail: 'failed to parse response' };
  }

  const indexers = collectToggleEntries(parsed);
  const enabled = indexers.filter(indexer => indexer.enable === true);
  const detail = enabled.length ? `enabled: ${summarizeNames(enabled)}` : 'no enabled indexers';

  return {
    name,
    ok: enabled.length > 0,
    detail
  };
}

export async function checkPfSyncHeartbeat(container = 'gluetun') {
  const name = 'pf-sync heartbeat';
  const mtime = await getFileMtime(container, '/tmp/gluetun/forwarded_port');
  if (!mtime) {
    return { name, ok: false, detail: 'forwarded_port file missing' };
  }
  const ageSec = Math.round((Date.now() - mtime) / 1000);
  const ok = ageSec < 180;
  return {
    name,
    ok,
    detail: `age=${String(ageSec)}s`
  };
}

export async function checkDiskUsage(container = 'qbittorrent', pathInput: string | undefined = process.env.MEDIA_DIR) {
  const name = 'Disk usage';
  const path = pathInput && pathInput !== '' ? pathInput : '/config';
  const usage = await dockerDiskUsage(container, path);
  if (!usage) {
    return { name, ok: false, detail: 'unable to read disk usage' };
  }
  if (usage.usedPercent === null) {
    return { name, ok: false, detail: 'unable to read disk usage' };
  }
  const ok = usage.usedPercent < 90;
  return {
    name,
    ok,
    detail: `${String(usage.usedPercent)}% used (${usage.available} free)`
  };
}

export async function checkImageAge(containers: string[] = [
  'qbittorrent',
  'sonarr',
  'radarr',
  'prowlarr',
  'bazarr',
  'gluetun',
  'cross-seed',
  'recyclarr'
]) {
  const name = 'Container image age';
  const ages = await Promise.all(
    containers.map(async (container) => {
      const created = await getImageCreationDate(container).catch(() => null);
      if (!created) return null;
      const days = Math.round((Date.now() - created) / (1000 * 60 * 60 * 24));
      return `${container}: ${String(days)}d`;
    })
  );
  const detail = ages.filter(Boolean).join(' | ');
  if (!detail) {
    return { name, ok: false, detail: 'unable to inspect images' };
  }
  return {
    name,
    ok: true,
    detail
  };
}
