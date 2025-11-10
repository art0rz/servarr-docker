import express from "express";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { discoverServices } from "./lib/services.js";
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
  probeRecyclarr
} from "./lib/probes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

/**
 * Health check API endpoint
 */
app.get("/api/health", async (_req, res) => {
  try {
    const useVpn = process.env.USE_VPN === "true";

    // Discover service URLs from Docker
    const urls = await discoverServices();

    // Run probes based on VPN configuration
    let vpn = null;
    let qbitEgress = null;
    let checks = [];
    let services = [];

    if (useVpn) {
      // Run all probes including VPN
      const [vpnProbe, qbitEgressProbe, ...serviceProbes] = await Promise.all([
        probeGluetun(),
        probeQbitEgress(),
        probeSonarr(urls.sonarr),
        probeRadarr(urls.radarr),
        probeProwlarr(urls.prowlarr),
        probeBazarr(urls.bazarr),
        probeQbit(urls.gluetun),
        probeCrossSeed(urls['cross-seed']),
        probeFlare(urls.flaresolverr),
        probeRecyclarr()
      ]);

      vpn = vpnProbe;
      qbitEgress = qbitEgressProbe;
      services = serviceProbes;

      // Build check results with VPN checks
      checks = [
        { name: "gluetun running", ok: vpn.running, detail: vpn.healthy ? `health=${vpn.healthy}` : "" },
        { name: "gluetun healthy", ok: vpn.healthy === "healthy", detail: `uiHostPort=${vpn.uiHostPort || ''}` },
        {
          name: "gluetun forwarded port",
          ok: vpn.pfExpected ? /^\d+$/.test(vpn.forwardedPort || "") : true,
          detail: vpn.pfExpected ? (vpn.forwardedPort || "pending") : "disabled"
        },
        { name: "qbittorrent egress via VPN", ok: !!qbitEgress.vpnEgress, detail: qbitEgress.vpnEgress || "" },
        { name: "gluetun egress IP", ok: !!vpn.vpnEgress, detail: vpn.vpnEgress || "" },
      ];
    } else {
      // Run probes without VPN
      services = await Promise.all([
        probeSonarr(urls.sonarr),
        probeRadarr(urls.radarr),
        probeProwlarr(urls.prowlarr),
        probeBazarr(urls.bazarr),
        probeQbit(urls.qbittorrent),
        probeCrossSeed(urls['cross-seed']),
        probeFlare(urls.flaresolverr),
        probeRecyclarr()
      ]);

      vpn = { name: "VPN", ok: false, running: false, healthy: null };
      qbitEgress = { name: "qBittorrent egress", ok: true, vpnEgress: "VPN disabled" };
      checks = [
        { name: "VPN status", ok: true, detail: "disabled (no VPN configured)" }
      ];
    }

    res.json({
      vpn,
      qbitEgress,
      services,
      checks,
      nets: [], // Legacy field for UI compatibility
    });
  } catch (error) {
    console.error("Health check error:", error);
    res.status(500).json({ error: "Health check failed" });
  }
});

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
