import { cmd, dockerInspect, dockerEnvMap, getEgressIP } from './docker.js';

function buildHeaderArgs(headers = []) {
  return headers
    .filter(Boolean)
    .map(header => `-H ${JSON.stringify(header)}`)
    .join(" ");
}

function arrHeaders(apiKey) {
  return apiKey ? [`X-Api-Key: ${apiKey}`] : [];
}

function qbitHeaders(baseUrl, extras = []) {
  return [`Referer: ${baseUrl}/`, `Origin: ${baseUrl}`, ...extras];
}

function headerArgsString(headers = []) {
  const args = buildHeaderArgs(headers);
  return args ? `${args} ` : "";
}

/**
 * Make a GET request using curl
 */
async function httpGet(url, options = {}) {
  const timeout = options.timeout || 3;
  const headerArgs = buildHeaderArgs(options.headers);
  const headerSegment = headerArgs ? `${headerArgs} ` : "";
  return cmd(`curl -sS -m ${timeout} ${headerSegment}${JSON.stringify(url)}`);
}

/**
 * Make a POST request using curl
 */
async function httpPost(url, body, options = {}) {
  const data = JSON.stringify(body);
  const headers = ["Content-Type: application/json", ...(options.headers || [])];
  const headerArgs = buildHeaderArgs(headers);
  const timeout = options.timeout || 4;
  return cmd(`curl -sS -m ${timeout} ${headerArgs} --data ${JSON.stringify(data)} ${JSON.stringify(url)}`);
}

/**
 * Generic probe for *arr services (Sonarr, Radarr, Prowlarr, Bazarr)
 */
async function probeArrService(name, url, headers, apiVersion = 'v3') {
  if (!url) return { name, ok: false, reason: "container not found" };

  const status = await httpGet(`${url}/api/${apiVersion}/system/status`, { headers });
  const ok = status.ok;
  let version = "";

  if (ok) {
    try {
      version = JSON.parse(status.out).version || "";
    } catch {}
  }

  return { name, url, ok, version, http: ok ? 200 : 0 };
}

/**
 * Probe Sonarr with queue info
 */
export async function probeSonarr(url, apiKey) {
  const headers = arrHeaders(apiKey);
  const base = await probeArrService("Sonarr", url, headers, "v3");
  if (!base.ok) return base;

  const queue = await httpGet(`${url}/api/v3/queue?page=1&pageSize=1`, { headers });
  let count = 0;
  try {
    const data = JSON.parse(queue.out);
    count = data.totalRecords || 0;
  } catch {}

  return { ...base, queue: count };
}

/**
 * Probe Radarr with queue info
 */
export async function probeRadarr(url, apiKey) {
  const headers = arrHeaders(apiKey);
  const base = await probeArrService("Radarr", url, headers, "v3");
  if (!base.ok) return base;

  const queue = await httpGet(`${url}/api/v3/queue?page=1&pageSize=1`, { headers });
  let count = 0;
  try {
    const data = JSON.parse(queue.out);
    count = data.totalRecords || 0;
  } catch {}

  return { ...base, queue: count };
}

/**
 * Probe Prowlarr with indexer count
 */
export async function probeProwlarr(url, apiKey) {
  const headers = arrHeaders(apiKey);
  const base = await probeArrService("Prowlarr", url, headers, "v1");
  if (!base.ok) return base;

  const indexers = await httpGet(`${url}/api/v1/indexer`, { headers });
  let active = 0;
  try {
    active = JSON.parse(indexers.out).filter(i => i.enable).length;
  } catch {}

  return { ...base, indexers: active };
}

/**
 * Probe Bazarr
 */
export async function probeBazarr(url) {
  if (!url) return { name: "Bazarr", ok: false, reason: "container not found" };

  const status = await httpGet(`${url}/api/system/status`);
  const ok = status.ok;
  let version = "";

  if (ok) {
    try {
      version = JSON.parse(status.out).version || "";
    } catch {}
  }

  return { name: "Bazarr", url, ok, version, http: ok ? 200 : 0 };
}

/**
 * Probe qBittorrent (whitelist bypass)
 */
export async function probeQbit(url, auth) {
  const name = "qBittorrent";
  if (!url) return { name, ok: false, reason: "container not found" };

  const headerArgs = headerArgsString(qbitHeaders(url));
  const versionResult = await cmd(
    `curl -sS -m 3 ${headerArgs}-w "%{http_code}" -o - ${JSON.stringify(url + "/api/v2/app/webapiVersion")}`
  );

  let ok = false;
  let version = "";

  if (versionResult.ok) {
    const body = versionResult.out.slice(0, -3).trim();
    const code = versionResult.out.slice(-3);

    if (code === "200" && !/^Forbidden/i.test(body)) {
      ok = true;
      version = body;
    }
  }

  let dl = null;
  let up = null;
  let total = null;
  let listenPort = null;

  if (ok && auth?.username && auth?.password) {
    const cookie = await qbitLogin(url, auth).catch(() => null);
    if (cookie) {
      const stats = await fetchQbitStats(url, cookie);
      if (stats) {
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

  const reason = versionResult.ok ? "not whitelisted" : (versionResult.err || versionResult.out || "unreachable");
  return { name, url, ok: false, reason, http: 0 };
}

/**
 * Probe FlareSolverr
 */
export async function probeFlare(url) {
  if (!url) return { name: "FlareSolverr", ok: false, reason: "container not found" };

  const result = await httpPost(`${url}/v1`, { cmd: "sessions.list" });
  const ok = result.ok;
  let sessions = 0;

  if (ok) {
    try {
      const data = JSON.parse(result.out);
      sessions = (data.sessions || []).length;
    } catch {}
  }

  return { name: "FlareSolverr", url, ok, sessions, http: ok ? 200 : 0 };
}

/**
 * Probe Cross-Seed
 */
export async function probeCrossSeed(url) {
  if (!url) return { name: "Cross-Seed", ok: false, reason: "container not found" };

  const result = await httpGet(`${url}/api/ping`);
  const ok = result.ok;

  if (ok) {
    return { name: "Cross-Seed", url, ok: true, version: "", http: 200 };
  }

  return { name: "Cross-Seed", url, ok: false, http: 0 };
}

/**
 * Probe Gluetun VPN gateway
 */
export async function probeGluetun() {
  const name = "gluetun";
  const env = await dockerEnvMap(name);
  const pfExpected = (env.VPN_PORT_FORWARDING || env.PORT_FORWARDING || "").toLowerCase() === "on";

  const [healthy, running, forwarded, uiMap, ip] = await Promise.all([
    dockerInspect(".State.Health.Status", name),
    dockerInspect(".State.Running", name),
    cmd(`docker exec ${name} sh -c 'cat /tmp/gluetun/forwarded_port 2>/dev/null || true'`),
    dockerInspect(`.NetworkSettings.Ports["8080/tcp"]`, name),
    getEgressIP(name).catch(() => "")
  ]);

  const uiHostPort = Array.isArray(uiMap) && uiMap[0] ? uiMap[0].HostPort : "";

  return {
    name: "Gluetun",
    container: name,
    ok: running === true && healthy === "healthy",
    running: running === true,
    healthy: healthy || null,
    vpnEgress: ip || "",
    forwardedPort: forwarded.ok ? forwarded.out.trim() : "",
    pfExpected,
    uiHostPort: uiHostPort || "",
  };
}

/**
 * Check qBittorrent egress IP
 */
export async function probeQbitEgress() {
  const ip = await getEgressIP("qbittorrent").catch(() => "");
  return {
    name: "qBittorrent egress",
    container: "qbittorrent",
    ok: !!ip,
    vpnEgress: ip || "",
  };
}

/**
 * Probe Recyclarr by checking Docker logs
 */
export async function probeRecyclarr() {
  const name = "Recyclarr";

  // Check if container is running
  const running = await dockerInspect(".State.Running", "recyclarr");
  if (running !== true) {
    return { name, ok: false, reason: "container not running" };
  }

  // Get logs from last 24 hours using since flag
  const logs = await cmd(`docker logs recyclarr --since 24h 2>&1`);

  if (!logs.ok) {
    return { name, ok: false, reason: "failed to read logs" };
  }

  // Count errors in last 24h
  const logLines = logs.out.split('\n');
  const errorLines = logLines.filter(line => {
    const lower = line.toLowerCase();
    return lower.includes("[err]") || (lower.includes("error") && !lower.includes("0 error"));
  });
  const errorCount = errorLines.length;

  // Check for success indicators
  const logText = logs.out.toLowerCase();
  const hasSuccess = logText.includes("completed successfully") ||
                     logText.includes("[inf]") ||
                     logText.includes("starting cron");

  // Consider healthy if running with success indicators and no errors
  const ok = hasSuccess && errorCount === 0;

  return {
    name,
    ok,
    version: "",
    http: 0,
    detail: errorCount === 0 ? "no errors (24h)" : `${errorCount} error${errorCount !== 1 ? 's' : ''} (24h)`
  };
}

async function qbitLogin(url, auth) {
  const payload = `username=${encodeURIComponent(auth.username)}&password=${encodeURIComponent(auth.password)}`;
  const headers = qbitHeaders(url, ["Content-Type: application/x-www-form-urlencoded"]);
  const command = `curl -sS -m 4 ${headerArgsString(headers)}-D - -o /dev/null --data ${JSON.stringify(payload)} ${JSON.stringify(url + "/api/v2/auth/login")}`;
  const response = await cmd(command);
  if (!response.ok) return null;

  const match = response.out.match(/set-cookie:\s*SID=([^;]+)/i);
  return match ? match[1].trim() : null;
}

async function fetchQbitStats(url, cookie) {
  const headers = qbitHeaders(url, [`Cookie: SID=${cookie}`]);
  const [transfer, torrents, prefs] = await Promise.all([
    httpGet(`${url}/api/v2/transfer/info`, { headers, timeout: 4 }),
    httpGet(`${url}/api/v2/torrents/info?filter=all`, { headers, timeout: 5 }),
    httpGet(`${url}/api/v2/app/preferences`, { headers, timeout: 4 })
  ]);

  let dl = null;
  let up = null;
  let total = null;
  let listenPort = null;

  if (transfer.ok) {
    try {
      const data = JSON.parse(transfer.out);
      dl = typeof data.dlspeed === "number" ? data.dlspeed : null;
      up = typeof data.upspeed === "number" ? data.upspeed : null;
    } catch {}
  }

  if (torrents.ok) {
    try {
      const list = JSON.parse(torrents.out);
      total = Array.isArray(list) ? list.length : null;
    } catch {}
  }

  if (prefs.ok) {
    try {
      const pref = JSON.parse(prefs.out);
      if (typeof pref.listen_port === "number") {
        listenPort = pref.listen_port;
      }
    } catch {}
  }

  if (dl === null && up === null && total === null && listenPort === null) {
    return null;
  }

  return { dl, up, total, listenPort };
}

function summarizeNames(items) {
  return items
    .map(item => item?.name)
    .filter(Boolean)
    .join(", ");
}

async function checkArrDownloadClients(label, url, apiKey) {
  if (!url) return { name: label, ok: false, detail: "service URL unavailable" };
  if (!apiKey) return { name: label, ok: false, detail: "API key unavailable" };

  const headers = arrHeaders(apiKey);
  const response = await httpGet(`${url}/api/v3/downloadclient`, { headers, timeout: 4 });
  if (!response.ok) {
    return { name: label, ok: false, detail: response.err || response.out || "request failed" };
  }

  try {
    const clients = JSON.parse(response.out);
    const enabled = clients.filter(client => client.enable);
    const detail = enabled.length
      ? `enabled: ${summarizeNames(enabled)}`
      : "no enabled clients";

    return {
      name: label,
      ok: enabled.length > 0,
      detail
    };
  } catch {
    return { name: label, ok: false, detail: "failed to parse response" };
  }
}

export async function checkSonarrDownloadClients(url, apiKey) {
  return checkArrDownloadClients("Sonarr download clients", url, apiKey);
}

export async function checkRadarrDownloadClients(url, apiKey) {
  return checkArrDownloadClients("Radarr download clients", url, apiKey);
}

export async function checkProwlarrIndexers(url, apiKey) {
  const name = "Prowlarr indexers";
  if (!url) return { name, ok: false, detail: "service URL unavailable" };
  if (!apiKey) return { name, ok: false, detail: "API key unavailable" };

  const headers = arrHeaders(apiKey);
  const response = await httpGet(`${url}/api/v1/indexer`, { headers, timeout: 4 });
  if (!response.ok) {
    return { name, ok: false, detail: response.err || response.out || "request failed" };
  }

  try {
    const indexers = JSON.parse(response.out);
    const enabled = indexers.filter(indexer => indexer.enable);
    const detail = enabled.length
      ? `enabled: ${summarizeNames(enabled)}`
      : "no enabled indexers";

    return {
      name,
      ok: enabled.length > 0,
      detail
    };
  } catch {
    return { name, ok: false, detail: "failed to parse response" };
  }
}
