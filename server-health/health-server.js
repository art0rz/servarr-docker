import express from "express";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
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
  checkProwlarrIndexers,
  checkPfSyncHeartbeat,
  checkDiskUsage,
  checkImageAge
} from "./lib/probes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const HEALTH_INTERVAL_MS = parseInt(process.env.HEALTH_INTERVAL_MS || "1000", 10);
const USE_VPN = process.env.USE_VPN === "true";
const GIT_REF = resolveGitRef();

let healthCache = {
  vpn: USE_VPN ? { name: "VPN", ok: false, running: false, healthy: null } : { name: "VPN", ok: false, running: false, healthy: null },
  qbitEgress: USE_VPN
    ? { name: "qBittorrent egress", ok: false, vpnEgress: "" }
    : { name: "qBittorrent egress", ok: true, vpnEgress: "VPN disabled" },
  services: [],
  checks: USE_VPN ? [] : [{ name: "VPN status", ok: true, detail: "disabled (no VPN configured)" }],
  nets: [],
  updatedAt: null,
  updating: true,
  error: "initializing",
  gitRef: GIT_REF
};

app.get("/api/health", (_req, res) => {
  res.json(healthCache);
});

function resolveGitRef() {
  if (process.env.GIT_REF) return process.env.GIT_REF;
  try {
    const raw = readFileSync("/app/.gitref", "utf-8");
    const match = raw.match(/GIT_REF=(.+)/);
    return match ? match[1].trim() : raw.trim();
  } catch {
    return "";
  }
}

function publish(partial) {
  healthCache = {
    ...healthCache,
    ...partial,
    updatedAt: new Date().toISOString(),
    updating: false,
    error: partial.error ?? null,
    gitRef: GIT_REF
  };
}

function startWatcher(name, fn, interval) {
  const run = async () => {
    try {
      await fn();
    } catch (error) {
      console.error(`Watcher ${name} failed:`, error);
      publish({ error: `${name}: ${error.message}` });
    } finally {
      setTimeout(run, interval);
    }
  };
  run();
}

async function updateVpnSection() {
  if (!USE_VPN) {
    publish({
      vpn: { name: "VPN", ok: false, running: false, healthy: null },
      qbitEgress: { name: "qBittorrent egress", ok: true, vpnEgress: "VPN disabled" }
    });
    return;
  }
  const [vpn, qbitEgress] = await Promise.all([probeGluetun(), probeQbitEgress()]);
  publish({ vpn, qbitEgress });
}

async function updateServicesSection() {
  const urls = await discoverServices();
  const apiKeys = await loadArrApiKeys();
  const qbitAuth = await loadQbitCredentials();
  const qbitUrl = USE_VPN ? urls.gluetun : urls.qbittorrent;
  const probes = [
    probeSonarr(urls.sonarr, apiKeys.sonarr),
    probeRadarr(urls.radarr, apiKeys.radarr),
    probeProwlarr(urls.prowlarr, apiKeys.prowlarr),
    probeBazarr(urls.bazarr),
    probeQbit(qbitUrl, qbitAuth),
    probeCrossSeed(urls["cross-seed"]),
    probeFlare(urls.flaresolverr),
    probeRecyclarr()
  ];
  const services = await Promise.all(probes);
  publish({ services });
}

async function updateChecksSection() {
  const urls = await discoverServices();
  const apiKeys = await loadArrApiKeys();
  const vpn = healthCache.vpn;
  const qbitEgress = healthCache.qbitEgress;
  const qbitService = (healthCache.services || []).find(s => s.name === "qBittorrent") || null;
  const checks = [];

  if (USE_VPN && vpn) {
    checks.push(
      { name: "gluetun running", ok: vpn.running === true, detail: vpn.healthy ? `health=${vpn.healthy}` : "" },
      { name: "gluetun healthy", ok: vpn.healthy === "healthy", detail: `uiHostPort=${vpn.uiHostPort || ''}` },
      {
        name: "gluetun forwarded port",
        ok: vpn.pfExpected ? /^\d+$/.test(vpn.forwardedPort || "") : true,
        detail: vpn.pfExpected ? (vpn.forwardedPort || "pending") : "disabled"
      },
      { name: "qbittorrent egress via VPN", ok: !!qbitEgress?.vpnEgress, detail: qbitEgress?.vpnEgress || "" },
      { name: "gluetun egress IP", ok: !!vpn.vpnEgress, detail: vpn.vpnEgress || "" }
    );

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
    checks.push({ name: "qbittorrent port matches VPN forwarded port", ok: okPort, detail });
  }

  if (!USE_VPN) {
    checks.push({ name: "VPN status", ok: true, detail: "disabled (no VPN configured)" });
  }

  const [integrationChecks, systemChecks] = await Promise.all([
    Promise.all([
      checkSonarrDownloadClients(urls.sonarr, apiKeys.sonarr),
      checkRadarrDownloadClients(urls.radarr, apiKeys.radarr),
      checkProwlarrIndexers(urls.prowlarr, apiKeys.prowlarr)
    ]),
    Promise.all([
      USE_VPN ? checkPfSyncHeartbeat() : Promise.resolve({ name: "pf-sync heartbeat", ok: true, detail: "vpn disabled" }),
      checkDiskUsage(),
      checkImageAge()
    ])
  ]);

  publish({ checks: [...checks, ...integrationChecks, ...systemChecks] });
}

startWatcher("vpn", updateVpnSection, HEALTH_INTERVAL_MS);
startWatcher("services", updateServicesSection, HEALTH_INTERVAL_MS);
startWatcher("checks", updateChecksSection, HEALTH_INTERVAL_MS * 2);

app.get("/", async (_req, res) => {
  try {
    const html = await readFile(join(__dirname, "lib", "ui.html"), "utf-8");
    res.type("html").send(html);
  } catch (error) {
    console.error("Failed to load UI:", error);
    res.status(500).send("Failed to load UI");
  }
});

app.listen(PORT, () => {
  console.log(`Health server listening on :${PORT}`);
});
