import { cmd, dockerInspect, dockerEnvMap, getEgressIP } from './docker.js';

/**
 * Make a GET request using curl
 */
async function httpGet(url) {
  return cmd(`curl -sS -m 3 ${JSON.stringify(url)}`);
}

/**
 * Make a POST request using curl
 */
async function httpPost(url, body) {
  const data = JSON.stringify(body);
  return cmd(`curl -sS -m 4 -H "Content-Type: application/json" --data ${JSON.stringify(data)} ${JSON.stringify(url)}`);
}

/**
 * Generic probe for *arr services (Sonarr, Radarr, Prowlarr, Bazarr)
 */
async function probeArrService(name, url, apiVersion = 'v3') {
  if (!url) return { name, ok: false, reason: "container not found" };

  const status = await httpGet(`${url}/api/${apiVersion}/system/status`);
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
export async function probeSonarr(url) {
  const base = await probeArrService("Sonarr", url, "v3");
  if (!base.ok) return base;

  const queue = await httpGet(`${url}/api/v3/queue?page=1&pageSize=1`);
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
export async function probeRadarr(url) {
  const base = await probeArrService("Radarr", url, "v3");
  if (!base.ok) return base;

  const queue = await httpGet(`${url}/api/v3/queue?page=1&pageSize=1`);
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
export async function probeProwlarr(url) {
  const base = await probeArrService("Prowlarr", url, "v1");
  if (!base.ok) return base;

  const indexers = await httpGet(`${url}/api/v1/indexer`);
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
export async function probeQbit(url) {
  const name = "qBittorrent";
  if (!url) return { name, ok: false, reason: "container not found" };

  const headers = `-H "Referer: ${url}/" -H "Origin: ${url}"`;
  const result = await cmd(`curl -sS -m 3 ${headers} -w "%{http_code}" -o - ${JSON.stringify(url + "/api/v2/app/webapiVersion")}`);

  if (result.ok) {
    const body = result.out.slice(0, -3).trim();
    const code = result.out.slice(-3);

    if (code === "200" && !/^Forbidden/i.test(body)) {
      return { name, url, ok: true, version: body, http: 200 };
    }
  }

  return { name, url, ok: false, reason: "not whitelisted", http: 0 };
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
