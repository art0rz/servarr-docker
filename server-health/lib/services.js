import { getContainerIP } from './docker.js';

// Get project name from environment (Docker Compose sets this)
const PROJECT = process.env.COMPOSE_PROJECT_NAME || 'servarr';
const USE_VPN = process.env.USE_VPN === 'true';

/**
 * Service configuration with default ports
 */
const SERVICE_CONFIG = {
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

/**
 * Discover service URLs from Docker containers
 */
export async function discoverServices() {
  const urls = {};

  for (const [name, config] of Object.entries(SERVICE_CONFIG)) {
    const port = parseInt(process.env[config.envPort] || config.defaultPort);
    const ip = await getContainerIP(name, config.network);

    if (ip) {
      urls[name] = `http://${ip}:${port}`;
    }
  }

  return urls;
}
