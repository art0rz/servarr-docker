import express from "express";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  discoverServices,
  loadDashboardConfig,
  probeServices,
  getIntegrationChecks,
  getSystemChecks,
  useVpn,
  updateHistory,
  getHistorySamples
} from "./services.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const INTERVAL_MS = 3000;

const app = express();

app.get("/api/health", (_req, res) => {
  res.json(loadDashboardConfig());
});

app.get("/api/qbit-history", (_req, res) => {
  res.json({
    updatedAt: new Date().toISOString(),
    samples: getHistorySamples()
  });
});

app.use("/", express.static(join(__dirname, "../../dist/client")));

function startWatcher(name: string, fn: () => Promise<void>, interval: number) {
  const run = async () => {
    try {
      await fn();
    } catch (error) {
      console.error(`Watcher ${name} failed`, error);
    } finally {
      setTimeout(run, interval);
    }
  };
  run();
}

startWatcher("services", async () => {
  const urls = await discoverServices();
  const services = await probeServices(urls);
  updateHistory(services);
}, INTERVAL_MS);

startWatcher("checks", async () => {
  const urls = await discoverServices();
  const checks = [
    ...(await getIntegrationChecks(urls)),
    ...(await getSystemChecks(urls))
  ];
  // update state with checks
}, INTERVAL_MS * 2);

app.listen(PORT, () => {
  console.log(`Health server listening on :${PORT}`);
});
