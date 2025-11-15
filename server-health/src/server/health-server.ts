import express from 'express';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadDashboardConfig,
  runVpnProbe,
  runServicesProbe,
  runChecksProbe,
  getHistorySamples
} from './services.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const INTERVAL_MS = 3000;

const app = express();

app.get('/api/health', (_req, res) => {
  res.json(loadDashboardConfig());
});

app.get('/api/qbit-history', (_req, res) => {
  res.json({
    updatedAt: new Date().toISOString(),
    samples: getHistorySamples()
  });
});

app.use('/', express.static(join(__dirname, '../client')));

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

startWatcher('vpn', runVpnProbe, INTERVAL_MS);
startWatcher('services', runServicesProbe, INTERVAL_MS);
startWatcher('checks', runChecksProbe, INTERVAL_MS * 2);

app.listen(PORT, () => {
  console.log(`Health server listening on :${PORT}`);
});
