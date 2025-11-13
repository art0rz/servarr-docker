import express from "express";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { discoverServices } from "./lib/services.js";
import { loadArrApiKeys, loadQbitCredentials } from "./lib/config.js";
import {
  probeGluetun,
  probeQbitEgress,
  probeSonarr,
  probeRadarr,
  probeProwlarr,
  probeBazarr,
  probeQbit,
  probeFlare,
  probeCrossSeed,
  probeRecyclarr,
  checkSonarrDownloadClients,
  checkRadarrDownloadClients,
  checkProwlarrIndexers
} from "./lib/probes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const HEALTH_INTERVAL_MS = parseInt(process.env.HEALTH_INTERVAL_MS || "10000", 10);

let healthCache = {
  vpn: null,
  qbitEgress: null,
  services: [],
  checks: [],
  nets: [],
  updatedAt: null,
  updating: true,
  error: "initializing"
};

/**
 * Health check API endpoint
 */
app.get("/api/health", (_req, res) => {
  res.json(healthCache);
});

async function checkHealth() {
  const useVpn = process.env.USE_VPN === "true";

  const urls = await discoverServices();
  const apiKeys = await loadArrApiKeys();
  const qbitAuth = await loadQbitCredentials();
  const qbitUrl = useVpn ? urls.gluetun : urls.qbittorrent;

  const baseProbes = [
    probeSonarr(urls.sonarr, apiKeys.sonarr),
    probeRadarr(urls.radarr, apiKeys.radarr),
    probeProwlarr(urls.prowlarr, apiKeys.prowlarr),
    probeBazarr(urls.bazarr),
    probeQbit(qbitUrl, qbitAuth),
    probeCrossSeed(urls["cross-seed"]),
    probeFlare(urls.flaresolverr),
    probeRecyclarr()
  ];

  const integrationChecksPromise = Promise.all([
    checkSonarrDownloadClients(urls.sonarr, apiKeys.sonarr),
    checkRadarrDownloadClients(urls.radarr, apiKeys.radarr),
    checkProwlarrIndexers(urls.prowlarr, apiKeys.prowlarr)
  ]);

  let vpn = null;
  let qbitEgress = null;
  let services = [];
  let qbitService = null;
  let checks = [];

  if (useVpn) {
    const [vpnProbe, qbitEgressProbe, ...serviceProbes] = await Promise.all([
      probeGluetun(),
      probeQbitEgress(),
      ...baseProbes
    ]);

    vpn = vpnProbe;
    qbitEgress = qbitEgressProbe;
    services = serviceProbes;
    qbitService = serviceProbes.find(s => s.name === "qBittorrent") || null;

    checks = [
      { name: "gluetun running", ok: vpn.running, detail: vpn.healthy ? `health=${vpn.healthy}` : "" },
      { name: "gluetun healthy", ok: vpn.healthy === "healthy", detail: `uiHostPort=${vpn.uiHostPort || ''}` },
      {
        name: "gluetun forwarded port",
        ok: vpn.pfExpected ? /^\d+$/.test(vpn.forwardedPort || "") : true,
        detail: vpn.pfExpected ? (vpn.forwardedPort || "pending") : "disabled"
      },
      { name: "qbittorrent egress via VPN", ok: !!qbitEgress.vpnEgress, detail: qbitEgress.vpnEgress || "" },
      { name: "gluetun egress IP", ok: !!vpn.vpnEgress, detail: vpn.vpnEgress || "" }
    ];
  } else {
    services = await Promise.all(baseProbes);
    qbitService = services.find(s => s.name === "qBittorrent") || null;
    vpn = { name: "VPN", ok: false, running: false, healthy: null };
    qbitEgress = { name: "qBittorrent egress", ok: true, vpnEgress: "VPN disabled" };
    checks = [{ name: "VPN status", ok: true, detail: "disabled (no VPN configured)" }];
  }

  if (useVpn && vpn.pfExpected) {
    const vpnPort = parseInt(vpn.forwardedPort || "", 10);
    let okPort = false;
    let detail = "";

    if (!Number.isInteger(vpnPort)) {
      detail = `forwarded port invalid (${vpn.forwardedPort || "missing"})`;
    } else if (typeof qbitService?.listenPort !== "number") {
      detail = "qBittorrent listen port unavailable";
    } else {
      okPort = qbitService.listenPort === vpnPort;
      detail = `vpn=${vpnPort}, qbit=${qbitService.listenPort}`;
    }

    checks.push({
      name: "qbittorrent port matches VPN forwarded port",
      ok: okPort,
      detail
    });
  }

  const integrationChecks = await integrationChecksPromise;
  checks = [...checks, ...integrationChecks];

  return {
    vpn,
    qbitEgress,
    services,
    checks,
    nets: [],
    updatedAt: new Date().toISOString(),
    updating: false,
    error: null
  };
}

async function refreshHealth() {
  try {
    const next = await checkHealth();
    healthCache = next;
  } catch (error) {
    console.error("Health refresh failed:", error);
    healthCache = {
      ...healthCache,
      error: error.message,
      updatedAt: new Date().toISOString(),
      updating: false
    };
  } finally {
    setTimeout(() => {
      healthCache = { ...healthCache, updating: true };
      refreshHealth();
    }, HEALTH_INTERVAL_MS);
  }
}

refreshHealth();

/**
 * Web UI
 */
app.get("/", async (_req, res) => {
  try {
    const html = await readFile(join(__dirname, "lib", "ui.html"), "utf-8");
    res.type("html").send(html);
  } catch (error) {
    console.error("Failed to load UI:", error);
    res.status(500).send("Failed to load UI");
  }
});

/**
 * Start server
 */
app.listen(PORT, () => {
  console.log(`Health server listening on :${PORT}`);
});
