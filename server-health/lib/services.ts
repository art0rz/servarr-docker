import { getContainerIP } from './docker';

// Get project name from environment (Docker Compose sets this)
const PROJECT = process.env['COMPOSE_PROJECT_NAME'] ?? 'servarr';
const USE_VPN = process.env['USE_VPN'] === 'true';

interface ServiceConfig {
  network: string;
  envPort: string;
  defaultPort: number;
}

/**
 * Service configuration with default ports
 */
const SERVICE_CONFIG: Record<string, ServiceConfig> = {
  sonarr: { network: `${PROJECT}_media`, envPort: 'SONARR_PORT', defaultPort: 8989 },
  radarr: { network: `${PROJECT}_media`, envPort: 'RADARR_PORT', defaultPort: 7878 },
  prowlarr: { network: `${PROJECT}_media`, envPort: 'PROWLARR_PORT', defaultPort: 9696 },
  bazarr: { network: `${PROJECT}_media`, envPort: 'BAZARR_PORT', defaultPort: 6767 },
  'cross-seed': { network: `${PROJECT}_media`, envPort: 'CROSS_SEED_PORT', defaultPort: 2468 },
  flaresolverr: { network: `${PROJECT}_media`, envPort: 'FLARESOLVERR_PORT', defaultPort: 8191 },
  // Conditional configuration based on VPN usage
  ...(USE_VPN
    ? { gluetun: { network: `${PROJECT}_default`, envPort: 'QBIT_WEBUI', defaultPort: 8080 } }
    : { qbittorrent: { network: `${PROJECT}_media`, envPort: 'QBIT_WEBUI', defaultPort: 8080 } }
  ),
};

export type ServiceUrls = Record<string, string>;

/**
 * Discover service URLs from Docker containers
 */
export async function discoverServices(): Promise<ServiceUrls> {
  const urls: ServiceUrls = {};

  for (const [name, config] of Object.entries(SERVICE_CONFIG)) {
    const envValue = process.env[config.envPort];
    const port = envValue !== undefined ? parseInt(envValue, 10) : config.defaultPort;
    const ip = await getContainerIP(name, config.network);

    if (ip !== null) {
      urls[name] = `http://${ip}:${String(port)}`;
    }
  }

  return urls;
}
