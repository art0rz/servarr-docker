import express, { type Request, type Response } from 'express';
import { readFileSync, promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import cron from 'node-cron';

import { logger } from './lib/logger';
import { discoverServices } from './lib/services';
import { loadArrApiKeys, loadQbitCredentials, watchConfigFiles, watchCrossSeedLog } from './lib/config';
import { watchDockerEvents, watchGluetunPort, watchContainerStats, getAllContainerMemoryUsage, refreshContainerStats } from './lib/docker';
import { getLoadAverage } from './lib/system';
import { createChartStoreHelpers, type ChartDataPoint } from './lib/chart-store';
import { createInitialHealthCache, applyHealthUpdate, type HealthCache } from './lib/health-cache';
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
  checkImageAge,
  type GluetunProbeResult,
  type QbitProbeResult,
  type CheckResult,
} from './lib/probes';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env['PORT'] ?? '3000';
const HEALTH_INTERVAL_MS = parseInt(process.env['HEALTH_INTERVAL_MS'] ?? '10000', 10);
const USE_VPN = process.env['USE_VPN'] === 'true';
const GIT_REF = resolveGitRef();
const CONFIG_ROOT = process.env['CONFIG_ROOT'] ?? '/config';
const HEALTH_DATA_DIR = process.env['HEALTH_DATA_DIR'] ?? join(CONFIG_ROOT, 'health-server');
const CHART_DATA_FILE = join(HEALTH_DATA_DIR, 'chart-data.json');
const DEFAULT_CHART_RETENTION_DAYS = 30;
const requestedRetentionDays = Number(process.env['CHART_RETENTION_DAYS']);
const CHART_RETENTION_DAYS =
  Number.isFinite(requestedRetentionDays) && requestedRetentionDays > 0
    ? requestedRetentionDays
    : DEFAULT_CHART_RETENTION_DAYS;
const CHART_RETENTION_MS = CHART_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const chartStoreHelpers = createChartStoreHelpers(CHART_RETENTION_MS);

// WebSocket clients
const wsClients = new Set<WebSocket>();

let healthCache: HealthCache = createInitialHealthCache({
  useVpn: USE_VPN,
  gitRef: GIT_REF,
  chartData: chartStoreHelpers.createEmptyStore(),
});

const containersToWatch = ['qbittorrent', 'sonarr', 'radarr', 'prowlarr', 'bazarr', 'cross-seed', 'flaresolverr', 'health-server'] as const;
const vpnContainersToWatch = ['gluetun', 'pf-sync'] as const;

function isFullGluetunResult(vpn: HealthCache['vpn']): vpn is GluetunProbeResult {
  return typeof vpn === 'object' && 'forwardedPort' in vpn && 'pfExpected' in vpn;
}

app.get('/api/health', (_req: Request, res: Response) => {
  // Send health data without chart data to keep response small
  const { chartData: _chartData, ...healthWithoutCharts } = healthCache;
  res.json(healthWithoutCharts);
});

// Separate endpoint for chart data with compact multi-resolution format
app.get('/api/charts', (_req: Request, res: Response) => {
  const payload = chartStoreHelpers.buildPayload(healthCache.chartData);
  res.json(payload);
});

function resolveGitRef() {
  const envRef = process.env['GIT_REF'];
  if (envRef !== undefined) return envRef;
  try {
    const raw = readFileSync('/app/.gitref', 'utf-8');
    const match = /GIT_REF=(.+)/.exec(raw);
    const result = match?.[1] !== undefined ? match[1].trim() : raw.trim();
    return result;
  } catch {
    return '';
  }
}

async function saveChartData() {
  try {
    await fs.mkdir(HEALTH_DATA_DIR, { recursive: true });
    await fs.writeFile(CHART_DATA_FILE, JSON.stringify(healthCache.chartData), 'utf-8');
  } catch (error) {
    logger.error({ err: error }, 'Failed to save chart data');
  }
}

async function loadChartData() {
  try {
    const raw = await fs.readFile(CHART_DATA_FILE, 'utf-8');
    const data = JSON.parse(raw) as unknown;

    if (Array.isArray(data)) {
      healthCache.chartData = chartStoreHelpers.convertLegacyData(data);
      logger.info({ dataPoints: { legacy: data.length } }, 'Loaded legacy chart data from disk');
      return;
    }

    if (typeof data === 'object' && data !== null) {
      healthCache.chartData = chartStoreHelpers.sanitizeStore(data as Record<string, unknown>);
      const counts = Object.fromEntries(
        Object.entries(healthCache.chartData).map(([resolution, buckets]) => [resolution, buckets.length])
      );
      logger.info({ dataPoints: counts }, 'Loaded chart data from disk');
      return;
    }

    logger.warn('Chart data file had unexpected format, starting fresh');
    healthCache.chartData = chartStoreHelpers.createEmptyStore();
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      logger.info('No existing chart data found (this is normal on first run)');
    } else {
      logger.error({ err }, 'Failed to load chart data');
    }
  }
}

function broadcastToClients(message: unknown) {
  const payload = JSON.stringify(message);
  for (const client of wsClients) {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(payload);
    }
  }
}

function publish(partial: Partial<HealthCache>) {
  // Log meaningful state changes for services
  if (partial.services !== undefined) {
    const oldServices = healthCache.services;
    const newServices = partial.services;

    for (const newSvc of newServices) {
      const oldSvc = oldServices.find(s => s.name === newSvc.name);
      if (oldSvc !== undefined && oldSvc.ok !== newSvc.ok) {
        if (newSvc.ok) {
          logger.info({ service: newSvc.name }, 'Service UP');
        } else {
          logger.warn({ service: newSvc.name }, 'Service DOWN');
        }
      }
    }
  }

  // Log meaningful state changes for checks
  if (partial.checks !== undefined) {
    const oldChecks = healthCache.checks;
    const newChecks = partial.checks;

    for (const newCheck of newChecks) {
      const oldCheck = oldChecks.find(c => c.name === newCheck.name);
      if (oldCheck !== undefined && oldCheck.ok !== newCheck.ok) {
        if (newCheck.ok) {
          logger.info({ check: newCheck.name, detail: newCheck.detail }, 'Check PASS');
        } else {
          logger.warn({ check: newCheck.name, detail: newCheck.detail }, 'Check FAIL');
        }
      }
    }
  }

  // Log VPN state changes
  if (partial.vpn !== undefined && 'running' in partial.vpn) {
    const oldVpn = healthCache.vpn;
    const newVpn = partial.vpn;
    if ('running' in oldVpn && oldVpn.running !== newVpn.running) {
      const status = newVpn.running ? 'started' : 'stopped';
      logger.info({ vpn: 'gluetun' }, `VPN ${status}`);
    }
    if ('running' in oldVpn && oldVpn.healthy !== newVpn.healthy) {
      logger.info({ vpn: 'gluetun', health: newVpn.healthy }, 'VPN health changed');
    }
  }

  const { cache: updatedCache, hasChanges } = applyHealthUpdate(healthCache, { ...partial, gitRef: GIT_REF });
  healthCache = updatedCache;

  // Only broadcast if data actually changed
  if (hasChanges && wsClients.size > 0) {
    const { chartData: _, ...updateData } = partial;
    broadcastToClients({
      type: 'health',
      data: updateData,
    });
  }
}

function startWatcher(name: string, fn: () => Promise<void>, intervalMs: number) {
  // Convert interval to cron expression
  const intervalSeconds = Math.floor(intervalMs / 1000);
  let cronExpression: string;

  if (intervalSeconds <= 59) {
    // Every N seconds
    cronExpression = `*/${String(intervalSeconds)} * * * * *`;
  } else if (intervalSeconds < 3600) {
    // Every N minutes
    const minutes = Math.floor(intervalSeconds / 60);
    cronExpression = `*/${String(minutes)} * * * *`;
  } else {
    // Every N hours
    const hours = Math.floor(intervalSeconds / 3600);
    cronExpression = `0 */${String(hours)} * * *`;
  }

  // Run immediately on startup
  fn().catch((error: unknown) => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, watcher: name }, 'Watcher failed');
    publish({ error: `${name}: ${errorMessage}` });
  });

  // Schedule with cron
  cron.schedule(cronExpression, () => {
    fn().catch((error: unknown) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, watcher: name }, 'Watcher failed');
      publish({ error: `${name}: ${errorMessage}` });
    });
  });

  logger.debug({ watcher: name, cron: cronExpression }, 'Scheduled watcher');
}

async function updateVpnSection() {
  if (!USE_VPN) {
    publish({
      vpn: { name: 'VPN', ok: false, running: false, healthy: null },
      qbitEgress: { name: 'qBittorrent egress', container: 'qbittorrent', ok: true, vpnEgress: 'VPN disabled' },
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
  const qbitUrl = USE_VPN ? urls['gluetun'] : urls['qbittorrent'];

  // Measure response time for each probe
  const responseTimes: Record<string, number> = {};

  async function timedProbe<T>(name: string, fn: Promise<T>): Promise<T> {
    const start = Date.now();
    const result = await fn;
    responseTimes[name] = Date.now() - start;
    return result;
  }

  const probes = [
    timedProbe('Sonarr', probeSonarr(urls['sonarr'], apiKeys['sonarr'] ?? null)),
    timedProbe('Radarr', probeRadarr(urls['radarr'], apiKeys['radarr'] ?? null)),
    timedProbe('Prowlarr', probeProwlarr(urls['prowlarr'], apiKeys['prowlarr'] ?? null)),
    timedProbe('Bazarr', probeBazarr(urls['bazarr'], apiKeys['bazarr'] ?? null)),
    timedProbe('qBittorrent', probeQbit(qbitUrl, qbitAuth)),
    timedProbe('Cross-Seed', probeCrossSeed(urls['cross-seed'])),
    timedProbe('FlareSolverr', probeFlare(urls['flaresolverr'])),
    timedProbe('Recyclarr', probeRecyclarr()),
  ];
  const services = await Promise.all(probes);

  // Track upload/download rates and load average for charts
  const qbitService = services.find(s => s.name === 'qBittorrent') as QbitProbeResult | undefined;
  const downloadRate = qbitService?.dl ?? 0;
  const uploadRate = qbitService?.up ?? 0;
  const loadAvg = await getLoadAverage();

  // Ensure we have fresh Docker stats for memory usage
  const memoryTargets = [...containersToWatch, ...(USE_VPN ? vpnContainersToWatch : [])];
  await Promise.all(memoryTargets.map(container => refreshContainerStats(container)));

  // Collect memory usage from all watched containers
  const allMemoryUsage = getAllContainerMemoryUsage();
  const memoryUsage: Record<string, number> = {};
  for (const [containerName, usage] of Object.entries(allMemoryUsage)) {
    memoryUsage[containerName] = Math.round(usage.usedBytes / 1024 / 1024); // Convert to MB
  }

  const newDataPoint: ChartDataPoint = {
    timestamp: Date.now(),
    downloadRate,
    uploadRate,
    load1: loadAvg.load1,
    load5: loadAvg.load5,
    load15: loadAvg.load15,
    responseTimes,
    memoryUsage,
  };

  chartStoreHelpers.appendSample(healthCache.chartData, newDataPoint);

  // Save to disk (async, don't wait for it)
  void saveChartData();

  // Broadcast services update and new chart point separately
  publish({ services });

  // Only broadcast chart point if there are connected clients
  if (wsClients.size > 0) {
    broadcastToClients({
      type: 'chartPoint',
      data: newDataPoint,
    });
  }
}

async function updateChecksSection() {
  const urls = await discoverServices();
  const apiKeys = await loadArrApiKeys();
  const vpn = healthCache.vpn;
  const qbitService = healthCache.services.find(s => s.name === 'qBittorrent') as QbitProbeResult | undefined;
  const checks: Array<CheckResult> = [];
  let qbitIngress: HealthCache['qbitIngress'] = null;
  let pfSyncInfo: CheckResult | null = null;

  if (USE_VPN && 'running' in vpn) {
    const gluetunVpn = isFullGluetunResult(vpn) ? vpn : undefined;
    const forwardedPort = gluetunVpn?.forwardedPort ?? '';
    const vpnPort = parseInt(forwardedPort.length > 0 ? forwardedPort : '', 10);
    qbitIngress = {
      hostPort: Number.isNaN(vpnPort) ? '' : String(vpnPort),
      listenPort: qbitService?.listenPort ?? null,
    };
  }

  if (!USE_VPN) {
    checks.push({ name: 'VPN status', ok: true, detail: 'disabled (no VPN configured)' });
    if (qbitService !== undefined) {
      qbitIngress = {
        hostPort: '',
        listenPort: qbitService.listenPort ?? null,
      };
    }
  }

  const [integrationChecks, pfSyncResult, systemChecks] = await Promise.all([
    Promise.all([
      checkSonarrDownloadClients(urls['sonarr'], apiKeys['sonarr'] ?? null),
      checkRadarrDownloadClients(urls['radarr'], apiKeys['radarr'] ?? null),
      checkProwlarrIndexers(urls['prowlarr'], apiKeys['prowlarr'] ?? null),
    ]),
    USE_VPN ? checkPfSyncHeartbeat() : Promise.resolve({ name: 'pf-sync heartbeat', ok: true, detail: 'vpn disabled' }),
    Promise.all([
      checkDiskUsage(),
      checkImageAge(),
    ]),
  ]);

  pfSyncInfo = pfSyncResult;

  publish({ checks: [...checks, ...integrationChecks, ...systemChecks], qbitIngress, pfSync: pfSyncInfo });
}

// Load persisted chart data from disk
void loadChartData();

// Start file watchers for config files
watchConfigFiles();

// Start Cross-Seed log watcher
watchCrossSeedLog();

// Start Docker event watcher
void watchDockerEvents();

// Start Docker stats watchers for all main containers (network throughput + memory usage)
for (const container of containersToWatch) {
  void watchContainerStats(container);
}

// Also watch gluetun if VPN is enabled
if (USE_VPN) {
  for (const container of vpnContainersToWatch) {
    void watchContainerStats(container);
  }
  void watchGluetunPort();
}

startWatcher('vpn', updateVpnSection, HEALTH_INTERVAL_MS);
startWatcher('services', updateServicesSection, HEALTH_INTERVAL_MS);
startWatcher('checks', updateChecksSection, HEALTH_INTERVAL_MS * 2);

// Serve static files from the built client
app.use(express.static(join(__dirname, '..', 'client')));

// Create HTTP server
const server = app.listen(PORT, () => {
  logger.info({
    port: PORT,
    containers: containersToWatch.length + (USE_VPN ? vpnContainersToWatch.length : 0),
    vpnEnabled: USE_VPN,
    checkIntervalSeconds: HEALTH_INTERVAL_MS / 1000,
    gitRef: GIT_REF.length > 0 ? GIT_REF : 'unknown',
  }, 'Health server started');
});

// Create WebSocket server
const wss = new WebSocketServer({ server });

wss.on('connection', (ws: WebSocket) => {
  wsClients.add(ws);

  ws.on('close', () => {
    wsClients.delete(ws);
  });

  ws.on('error', (error) => {
    logger.error({ err: error }, 'WebSocket error');
    wsClients.delete(ws);
  });
});
