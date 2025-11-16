import express, { type Request, type Response } from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { discoverServices } from './lib/services';
import { loadArrApiKeys, loadQbitCredentials, watchConfigFiles } from './lib/config';
import { getLoadAverage } from './lib/system';
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
  type QbitEgressProbeResult,
  type SonarrProbeResult,
  type RadarrProbeResult,
  type ProwlarrProbeResult,
  type BazarrProbeResult,
  type QbitProbeResult,
  type FlareProbeResult,
  type CrossSeedProbeResult,
  type RecyclarrProbeResult,
  type CheckResult,
} from './lib/probes';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env['PORT'] ?? '3000';
const HEALTH_INTERVAL_MS = parseInt(process.env['HEALTH_INTERVAL_MS'] ?? '10000', 10);
const USE_VPN = process.env['USE_VPN'] === 'true';
const GIT_REF = resolveGitRef();

type ServiceProbeResult =
  | SonarrProbeResult
  | RadarrProbeResult
  | ProwlarrProbeResult
  | BazarrProbeResult
  | QbitProbeResult
  | FlareProbeResult
  | CrossSeedProbeResult
  | RecyclarrProbeResult;

interface ChartDataPoint {
  timestamp: number;
  downloadRate: number;
  uploadRate: number;
  load1: number;
  load5: number;
  load15: number;
  responseTimes: Record<string, number>; // service name -> response time in ms
}

interface HealthCache {
  vpn: GluetunProbeResult | { name: string; ok: boolean; running: boolean; healthy: null };
  qbitEgress: QbitEgressProbeResult;
  services: Array<ServiceProbeResult>;
  checks: Array<CheckResult>;
  nets: Array<never>;
  chartData: Array<ChartDataPoint>;
  updatedAt: string | null;
  updating: boolean;
  error: string | null;
  gitRef: string;
}

let healthCache: HealthCache = {
  vpn: USE_VPN ? { name: 'VPN', ok: false, running: false, healthy: null } : { name: 'VPN', ok: false, running: false, healthy: null },
  qbitEgress: USE_VPN
    ? { name: 'qBittorrent egress', container: 'qbittorrent', ok: false, vpnEgress: '' }
    : { name: 'qBittorrent egress', container: 'qbittorrent', ok: true, vpnEgress: 'VPN disabled' },
  services: [],
  checks: USE_VPN ? [] : [{ name: 'VPN status', ok: true, detail: 'disabled (no VPN configured)' }],
  nets: [],
  chartData: [],
  updatedAt: null,
  updating: true,
  error: 'initializing',
  gitRef: GIT_REF,
};

app.get('/api/health', (_req: Request, res: Response) => {
  // Send health data without chart data to keep response small
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { chartData, ...healthWithoutCharts } = healthCache;
  res.json(healthWithoutCharts);
});

// Separate endpoint for chart data with compact format
app.get('/api/charts', (_req: Request, res: Response) => {
  const data = healthCache.chartData;
  if (data.length === 0) {
    res.json({ dataPoints: 0, services: [], timestamps: [], downloadRate: [], uploadRate: [], load1: [], responseTimes: {} });
    return;
  }

  // Quantize response times to nearest 10ms to reduce size
  const allServices = new Set<string>();
  for (const point of data) {
    for (const service of Object.keys(point.responseTimes)) {
      allServices.add(service);
    }
  }

  const compactResponseTimes: Record<string, Array<number>> = {};
  for (const service of allServices) {
    compactResponseTimes[service] = data.map(p => Math.round((p.responseTimes[service] ?? 0) / 10)); // Quantize to 10ms
  }

  res.json({
    dataPoints: data.length,
    services: Array.from(allServices),
    // Send actual timestamps from stored data
    timestamps: data.map(p => p.timestamp),
    // Arrays are more compact than objects
    downloadRate: data.map(p => Math.round(p.downloadRate)),
    uploadRate: data.map(p => Math.round(p.uploadRate)),
    load1: data.map(p => Math.round(p.load1 * 100) / 100), // 2 decimal places
    responseTimes: compactResponseTimes, // Quantized to 10ms buckets
  });
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

function publish(partial: Partial<HealthCache>) {
  healthCache = {
    ...healthCache,
    ...partial,
    updatedAt: new Date().toISOString(),
    updating: false,
    error: partial.error ?? null,
    gitRef: GIT_REF,
  };
}

function startWatcher(name: string, fn: () => Promise<void>, interval: number) {
  const run = async () => {
    try {
      await fn();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Watcher ${name} failed:`, error);
      publish({ error: `${name}: ${errorMessage}` });
    } finally {
      setTimeout(() => { void run(); }, interval);
    }
  };
  void run();
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

  const newDataPoint: ChartDataPoint = {
    timestamp: Date.now(),
    downloadRate,
    uploadRate,
    load1: loadAvg.load1,
    load5: loadAvg.load5,
    load15: loadAvg.load15,
    responseTimes,
  };

  const MAX_CHART_POINTS = 360; // Keep last 360 data points (1 hour at 10s intervals)
  const updatedChartData = [...healthCache.chartData, newDataPoint];
  if (updatedChartData.length > MAX_CHART_POINTS) {
    updatedChartData.shift(); // Remove oldest point
  }

  publish({ services, chartData: updatedChartData });
}

async function updateChecksSection() {
  const urls = await discoverServices();
  const apiKeys = await loadArrApiKeys();
  const vpn = healthCache.vpn;
  const qbitEgress = healthCache.qbitEgress;
  const qbitService = healthCache.services.find(s => s.name === 'qBittorrent') as QbitProbeResult | undefined;
  const checks: Array<CheckResult> = [];

  if (USE_VPN && 'running' in vpn) {
    const gluetunVpn = vpn as GluetunProbeResult;
    checks.push(
      { name: 'gluetun running', ok: gluetunVpn.running, detail: gluetunVpn.healthy !== null ? `health=${gluetunVpn.healthy}` : '' },
      { name: 'gluetun healthy', ok: gluetunVpn.healthy === 'healthy', detail: `uiHostPort=${gluetunVpn.uiHostPort.length > 0 ? gluetunVpn.uiHostPort : ''}` },
      {
        name: 'gluetun forwarded port',
        ok: gluetunVpn.pfExpected ? /^\d+$/.test(gluetunVpn.forwardedPort.length > 0 ? gluetunVpn.forwardedPort : '') : true,
        detail: gluetunVpn.pfExpected ? (gluetunVpn.forwardedPort.length > 0 ? gluetunVpn.forwardedPort : 'pending') : 'disabled',
      },
      { name: 'qbittorrent egress via VPN', ok: qbitEgress.vpnEgress.length > 0, detail: qbitEgress.vpnEgress.length > 0 ? qbitEgress.vpnEgress : '' },
      { name: 'gluetun egress IP', ok: gluetunVpn.vpnEgress.length > 0, detail: gluetunVpn.vpnEgress.length > 0 ? gluetunVpn.vpnEgress : '' }
    );

    const vpnPort = parseInt(gluetunVpn.forwardedPort.length > 0 ? gluetunVpn.forwardedPort : '', 10);
    let okPort = false;
    let detail = '';
    if (!Number.isInteger(vpnPort)) {
      detail = `forwarded port invalid (${gluetunVpn.forwardedPort.length > 0 ? gluetunVpn.forwardedPort : 'missing'})`;
    } else if (qbitService?.listenPort === null || qbitService?.listenPort === undefined) {
      detail = 'qBittorrent listen port unavailable';
    } else {
      okPort = qbitService.listenPort === vpnPort;
      detail = `vpn=${String(vpnPort)}, qbit=${String(qbitService.listenPort)}`;
    }
    checks.push({ name: 'qbittorrent port matches VPN forwarded port', ok: okPort, detail });
  }

  if (!USE_VPN) {
    checks.push({ name: 'VPN status', ok: true, detail: 'disabled (no VPN configured)' });
  }

  const [integrationChecks, systemChecks] = await Promise.all([
    Promise.all([
      checkSonarrDownloadClients(urls['sonarr'], apiKeys['sonarr'] ?? null),
      checkRadarrDownloadClients(urls['radarr'], apiKeys['radarr'] ?? null),
      checkProwlarrIndexers(urls['prowlarr'], apiKeys['prowlarr'] ?? null),
    ]),
    Promise.all([
      USE_VPN ? checkPfSyncHeartbeat() : Promise.resolve({ name: 'pf-sync heartbeat', ok: true, detail: 'vpn disabled' }),
      checkDiskUsage(),
      checkImageAge(),
    ]),
  ]);

  publish({ checks: [...checks, ...integrationChecks, ...systemChecks] });
}

// Start file watchers for config files
watchConfigFiles();

startWatcher('vpn', updateVpnSection, HEALTH_INTERVAL_MS);
startWatcher('services', updateServicesSection, HEALTH_INTERVAL_MS);
startWatcher('checks', updateChecksSection, HEALTH_INTERVAL_MS * 2);

// Serve static files from the built client
app.use(express.static(join(__dirname, '..', 'client')));

app.listen(PORT, () => {
  console.log(`Health server listening on :${PORT}`);
});
