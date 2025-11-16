import express, { type Request, type Response } from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { discoverServices } from './lib/services';
import { loadArrApiKeys, loadQbitCredentials } from './lib/config';
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
const HEALTH_INTERVAL_MS = parseInt(process.env['HEALTH_INTERVAL_MS'] ?? '1000', 10);
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
  res.json(healthCache);
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
  const probes = [
    probeSonarr(urls['sonarr'], apiKeys['sonarr'] ?? null),
    probeRadarr(urls['radarr'], apiKeys['radarr'] ?? null),
    probeProwlarr(urls['prowlarr'], apiKeys['prowlarr'] ?? null),
    probeBazarr(urls['bazarr']),
    probeQbit(qbitUrl, qbitAuth),
    probeCrossSeed(urls['cross-seed']),
    probeFlare(urls['flaresolverr']),
    probeRecyclarr(),
  ];
  const services = await Promise.all(probes);

  // Track upload/download rates for charts
  const qbitService = services.find(s => s.name === 'qBittorrent') as QbitProbeResult | undefined;
  const downloadRate = qbitService?.dl ?? 0;
  const uploadRate = qbitService?.up ?? 0;

  const newDataPoint: ChartDataPoint = {
    timestamp: Date.now(),
    downloadRate,
    uploadRate,
  };

  const MAX_CHART_POINTS = 60; // Keep last 60 data points (1 minute at 1s intervals)
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

startWatcher('vpn', updateVpnSection, HEALTH_INTERVAL_MS);
startWatcher('services', updateServicesSection, HEALTH_INTERVAL_MS);
startWatcher('checks', updateChecksSection, HEALTH_INTERVAL_MS * 2);

// Serve static files from the built client
app.use(express.static(join(__dirname, '..', 'client')));

app.listen(PORT, () => {
  console.log(`Health server listening on :${PORT}`);
});
