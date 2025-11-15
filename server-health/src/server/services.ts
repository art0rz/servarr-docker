import { getContainerIP } from './docker.js';
import {
  loadArrApiKeys,
  loadQbitDashboardContext,
  resolveGitRef
} from './config.js';
import {
  checkDiskUsage,
  checkImageAge,
  checkPfSyncHeartbeat,
  checkProwlarrIndexers,
  checkRadarrDownloadClients,
  checkSonarrDownloadClients,
  probeBazarr,
  probeCrossSeed,
  probeFlare,
  probeGluetun,
  probeProwlarr,
  probeQbit,
  probeQbitEgress,
  probeRadarr,
  probeRecyclarr,
  probeSonarr,
  ServiceResult
} from './probes.js';

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface HealthState {
  vpn: ServiceResult | null;
  qbitEgress: ServiceResult | null;
  services: ServiceResult[];
  checks: CheckResult[];
  nets: string[];
  updatedAt: string | null;
  updating: boolean;
  error: string | null;
  gitRef: string;
}

interface HistorySample {
  timestamp: number;
  dl: number;
  up: number;
}

const projectEnv = process.env.COMPOSE_PROJECT_NAME;
const PROJECT = projectEnv && projectEnv !== '' ? projectEnv : 'servarr';
const USE_VPN = process.env.USE_VPN === 'true';
const HISTORY_RETENTION_MS = 10 * 60 * 1000;
const GIT_REF = resolveGitRef();

const SERVICE_CONFIG: Record<
  string,
  { network: string, envPort: string, defaultPort: number, }
> = {
  'sonarr': { network: `${PROJECT}_media`, envPort: 'SONARR_PORT', defaultPort: 8989 },
  'radarr': { network: `${PROJECT}_media`, envPort: 'RADARR_PORT', defaultPort: 7878 },
  'prowlarr': { network: `${PROJECT}_media`, envPort: 'PROWLARR_PORT', defaultPort: 9696 },
  'bazarr': { network: `${PROJECT}_media`, envPort: 'BAZARR_PORT', defaultPort: 6767 },
  'cross-seed': { network: `${PROJECT}_media`, envPort: 'CROSS_SEED_PORT', defaultPort: 2468 },
  'flaresolverr': { network: `${PROJECT}_media`, envPort: 'FLARESOLVERR_PORT', defaultPort: 8191 },
  ...(USE_VPN
    ? { gluetun: { network: `${PROJECT}_default`, envPort: 'QBIT_WEBUI', defaultPort: 8080 } }
    : { qbittorrent: { network: `${PROJECT}_media`, envPort: 'QBIT_WEBUI', defaultPort: 8080 } })
};

const qbitHistory: HistorySample[] = [];

let healthCache: HealthState = {
  vpn: USE_VPN ? { name: 'VPN', ok: false, running: false, healthy: null } : null,
  qbitEgress: USE_VPN
    ? { name: 'qBittorrent egress', ok: false, vpnEgress: '' }
    : null,
  services: [],
  checks: [],
  nets: [],
  updatedAt: null,
  updating: true,
  error: 'initializing',
  gitRef: GIT_REF
};

function publish(partial: Partial<HealthState> & { error?: string | null, }) {
  healthCache = {
    ...healthCache,
    ...partial,
    updatedAt: new Date().toISOString(),
    updating: false,
    error: partial.error ?? null,
    gitRef: GIT_REF
  };
}

export function loadDashboardConfig(): HealthState {
  return healthCache;
}

export function useVpn(): boolean {
  return USE_VPN;
}

export async function discoverServices(): Promise<Record<string, string>> {
  const urls: Record<string, string> = {};
  for (const [name, config] of Object.entries(SERVICE_CONFIG)) {
    const configuredPort = process.env[config.envPort];
    const portValue = configuredPort && configuredPort !== '' ? configuredPort : String(config.defaultPort);
    const port = parseInt(portValue, 10);
    const ip = await getContainerIP(name, config.network);
    if (ip && Number.isFinite(port)) {
      urls[name] = `http://${ip}:${String(port)}`;
    }
  }
  return urls;
}

function updateHistory(services: ServiceResult[]) {
  const qbitProbe = services.find(s => s.name === 'qBittorrent');
  if (qbitProbe && (typeof qbitProbe.dl === 'number' || typeof qbitProbe.up === 'number')) {
    qbitHistory.push({
      timestamp: Date.now(),
      dl: qbitProbe.dl ?? 0,
      up: qbitProbe.up ?? 0
    });
    const cutoff = Date.now() - HISTORY_RETENTION_MS;
    while (qbitHistory.length && qbitHistory[0].timestamp < cutoff) {
      qbitHistory.shift();
    }
  }
}

export function getHistorySamples(): HistorySample[] {
  return qbitHistory.map(sample => ({ ...sample }));
}

export async function runVpnProbe(): Promise<void> {
  if (!USE_VPN) {
    publish({
      vpn: null,
      qbitEgress: null
    });
    return;
  }
  const [vpn, qbitEgress] = await Promise.all([probeGluetun(), probeQbitEgress()]);
  publish({ vpn, qbitEgress });
}

export async function runServicesProbe(): Promise<void> {
  const urls = await discoverServices();
  const apiKeys = await loadArrApiKeys();
  const qbitContext = await loadQbitDashboardContext();
  const qbitUrl = qbitContext.url ?? (USE_VPN ? urls.gluetun : urls.qbittorrent);
  const probes = [
    probeSonarr(urls.sonarr, apiKeys.sonarr),
    probeRadarr(urls.radarr, apiKeys.radarr),
    probeProwlarr(urls.prowlarr, apiKeys.prowlarr),
    probeBazarr(urls.bazarr),
    probeQbit(qbitUrl, qbitContext),
    probeCrossSeed(urls['cross-seed']),
    probeFlare(urls.flaresolverr),
    probeRecyclarr()
  ];
  const services = await Promise.all(probes);
  updateHistory(services);
  publish({ services });
}

export async function runChecksProbe(): Promise<void> {
  const urls = await discoverServices();
  const apiKeys = await loadArrApiKeys();
  const vpn = healthCache.vpn;
  const qbitEgress = healthCache.qbitEgress;
  const qbitService = healthCache.services.find(s => s.name === 'qBittorrent') ?? null;
  const checks: CheckResult[] = [];

  if (USE_VPN && vpn && qbitEgress) {
    checks.push(
      {
        name: 'gluetun running',
        ok: vpn.running === true,
        detail: `health=${vpn.healthy ?? ''}`
      },
      {
        name: 'gluetun healthy',
        ok: vpn.healthy === 'healthy',
        detail: `uiHostPort=${vpn.uiHostPort ?? ''}`
      },
      {
        name: 'gluetun forwarded port',
        ok: vpn.pfExpected ? /^\d+$/.test(vpn.forwardedPort ?? '') : true,
        detail: vpn.pfExpected
          ? (vpn.forwardedPort && vpn.forwardedPort !== '' ? vpn.forwardedPort : 'pending')
          : 'disabled'
      },
      {
        name: 'qbittorrent egress via VPN',
        ok: !!qbitEgress.vpnEgress,
        detail: qbitEgress.vpnEgress ?? ''
      },
      { name: 'gluetun egress IP', ok: !!vpn.vpnEgress, detail: vpn.vpnEgress ?? '' }
    );

    const forwardedLabel = vpn.forwardedPort && vpn.forwardedPort !== '' ? vpn.forwardedPort : 'missing';
    const vpnPort = parseInt(vpn.forwardedPort ?? '', 10);
    let okPort = false;
    let detail = '';
    if (!Number.isInteger(vpnPort)) {
      detail = `forwarded port invalid (${forwardedLabel})`;
    } else if (typeof qbitService?.listenPort !== 'number') {
      detail = 'qBittorrent listen port unavailable';
    } else {
      okPort = qbitService.listenPort === vpnPort;
      detail = `vpn=${String(vpnPort)}, qbit=${String(qbitService.listenPort)}`;
    }
    checks.push({ name: 'qbittorrent port matches VPN forwarded port', ok: okPort, detail });
  }

  const systemTasks = USE_VPN
    ? [
      checkPfSyncHeartbeat(),
      checkDiskUsage(),
      checkImageAge()
    ]
    : [
      checkDiskUsage(),
      checkImageAge()
    ];

  const [integrationChecks, systemChecks] = await Promise.all([
    Promise.all([
      checkSonarrDownloadClients(urls.sonarr, apiKeys.sonarr),
      checkRadarrDownloadClients(urls.radarr, apiKeys.radarr),
      checkProwlarrIndexers(urls.prowlarr, apiKeys.prowlarr)
    ]),
    Promise.all(systemTasks)
  ]);

  publish({ checks: [...checks, ...integrationChecks, ...systemChecks] });
}
