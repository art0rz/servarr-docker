import { getContainerIP } from './docker';

// Get project name from environment (Docker Compose sets this)
const PROJECT = process.env['COMPOSE_PROJECT_NAME'] ?? 'servarr';

interface ServiceConfig {
  network: string;
  envPort: string;
  defaultPort: number;
}

function isVpnEnabled(): boolean {
  return (process.env['USE_VPN'] ?? '').toLowerCase() === 'true';
}

function buildServiceConfig(): Record<string, ServiceConfig> {
  const base: Record<string, ServiceConfig> = {
    sonarr: { network: `${PROJECT}_media`, envPort: 'SONARR_PORT', defaultPort: 8989 },
    radarr: { network: `${PROJECT}_media`, envPort: 'RADARR_PORT', defaultPort: 7878 },
    prowlarr: { network: `${PROJECT}_media`, envPort: 'PROWLARR_PORT', defaultPort: 9696 },
    bazarr: { network: `${PROJECT}_media`, envPort: 'BAZARR_PORT', defaultPort: 6767 },
    'cross-seed': { network: `${PROJECT}_media`, envPort: 'CROSS_SEED_PORT', defaultPort: 2468 },
    flaresolverr: { network: `${PROJECT}_media`, envPort: 'FLARESOLVERR_PORT', defaultPort: 8191 },
  };

  if (isVpnEnabled()) {
    base['gluetun'] = { network: `${PROJECT}_default`, envPort: 'QBIT_WEBUI', defaultPort: 8080 };
  } else {
    base['qbittorrent'] = { network: `${PROJECT}_media`, envPort: 'QBIT_WEBUI', defaultPort: 8080 };
  }

  return base;
}

function resolvePort(envValue: string | undefined, fallback: number): number {
  if (envValue === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(envValue, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export type ServiceUrls = Record<string, string>;

/**
 * Discover service URLs from Docker containers
 */
export async function discoverServices() {
  const urls: ServiceUrls = {};
  const serviceConfig = buildServiceConfig();

  for (const [name, config] of Object.entries(serviceConfig)) {
    const envValue = process.env[config.envPort];
    const port = resolvePort(envValue, config.defaultPort);
    const ip = await getContainerIP(name, config.network);

    if (ip !== null) {
      urls[name] = `http://${ip}:${String(port)}`;
    }
  }

  return urls;
}
