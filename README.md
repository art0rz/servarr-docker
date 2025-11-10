# Servarr Media Stack

A complete Docker Compose setup for automated media management with VPN protection, port forwarding, and health monitoring.

## Features

- **VPN Protection**: All torrent traffic routed through Gluetun VPN gateway (supports all major VPN providers)
- **Automatic Port Forwarding**: Syncs VPN forwarded port to qBittorrent
- **Media Management**: Sonarr, Radarr, Prowlarr, Bazarr for automated downloads
- **Cross-Seeding**: Automatically finds and adds cross-seeds from your existing torrents
- **TRaSH Guides Integration**: Recyclarr syncs optimal quality profiles and custom formats
- **Captcha Solving**: FlareSolverr for indexer sites
- **Health Monitoring**: Real-time dashboard showing service status, VPN health, and egress IPs
- **Auto-Updates**: Watchtower keeps containers up to date

## Stack Components

| Service | Description | Port |
|---------|-------------|------|
| **Gluetun** | VPN client (any provider) | 8080 (qBittorrent WebUI) |
| **qBittorrent** | Torrent client (via VPN) | 8080 |
| **Sonarr** | TV show management | 8989 |
| **Radarr** | Movie management | 7878 |
| **Prowlarr** | Indexer manager | 9696 |
| **Bazarr** | Subtitle management | 6767 |
| **Cross-Seed** | Automatic cross-seeding | 2468 |
| **Recyclarr** | TRaSH guides sync | - |
| **FlareSolverr** | Cloudflare bypass | 8191 |
| **Health Server** | Monitoring dashboard | 3000 |
| **Watchtower** | Auto-updates containers | - |

## Quick Start

### 1. Prerequisites

- Docker and Docker Compose installed
- VPN credentials for your chosen provider (optional - setup works without VPN too)
- Sufficient storage mounted at `/mnt/media` (or configure `MEDIA_DIR`)

### 2. Setup

**Option A: Interactive Setup (Recommended)**

```bash
# Run bootstrap script - it will guide you through configuration
chmod +x bootstrap.sh
./bootstrap.sh
```

The script will:
1. Ask for your configuration (timezone, VPN provider & credentials, ports, etc.)
2. Auto-detect Docker GID
3. Create `.env` file
4. Set up directories
5. Start all services

**Option B: Manual Setup**

```bash
# Copy example environment file
cp .env.example .env

# Edit .env with your configuration
nano .env

# Run bootstrap
chmod +x bootstrap.sh
./bootstrap.sh
```

**Required Configuration (if using VPN):**
- `VPN_SERVICE_PROVIDER`: Your VPN provider (e.g., protonvpn, nordvpn, mullvad, etc.)
- `VPN_TYPE`: VPN protocol type (e.g., wireguard, openvpn)
- Provider-specific credentials (varies by provider - see Gluetun documentation)

**Optional Configuration (has sensible defaults):**
- `DOCKER_GID`: Docker group GID (auto-detected)
- `MEDIA_DIR`: Media storage location (default: /mnt/media)
- `TZ`: Timezone (default: Europe/Stockholm)
- Service ports (Sonarr: 8989, Radarr: 7878, etc.)

### Manual Setup (Alternative)

Or manually instead of using bootstrap.sh:

```bash
# Create directories
mkdir -p config/{qbittorrent,prowlarr,sonarr,radarr}
sudo mkdir -p /mnt/media/{downloads/{incomplete,completed},tv,movies}
sudo chown -R "${PUID:-1000}:${PGID:-1001}" /mnt/media

# Start services
docker compose up -d
```

## Configuration

### Environment Variables

See `.env.example` for all available options. Key variables:

```bash
# Basic settings
TZ=Europe/Stockholm
PUID=1000
PGID=1001
MEDIA_DIR=/mnt/media

# VPN configuration (if USE_VPN=true)
VPN_SERVICE_PROVIDER=protonvpn
VPN_TYPE=wireguard
SERVER_COUNTRIES=Sweden
# Provider-specific credentials (example for ProtonVPN WireGuard):
WIREGUARD_PRIVATE_KEY=your_private_key
WIREGUARD_ADDRESSES=your_wireguard_address

# Service ports
QBIT_WEBUI=8080
SONARR_PORT=8989
RADARR_PORT=7878
# ... etc
```

### VPN Setup

Gluetun supports all major VPN providers. Configuration varies by provider:

**Important Notes:**
- Not all VPN providers support port forwarding. Check with your provider before enabling VPN.
- Even if your provider supports port forwarding, not all servers may support it.
- Without port forwarding, you may experience reduced torrent performance (seeding/downloading speeds).
- If your provider doesn't support port forwarding, consider disabling VPN by setting `USE_VPN=false` in your `.env` file.

**ProtonVPN (WireGuard example):**
```bash
VPN_SERVICE_PROVIDER=protonvpn
VPN_TYPE=wireguard
WIREGUARD_PRIVATE_KEY=your_private_key_here
WIREGUARD_ADDRESSES=10.2.0.2/32
SERVER_COUNTRIES=Sweden
```

**NordVPN (example):**
```bash
VPN_SERVICE_PROVIDER=nordvpn
VPN_TYPE=wireguard
WIREGUARD_PRIVATE_KEY=your_private_key_here
SERVER_COUNTRIES=Sweden
```

**Mullvad (example):**
```bash
VPN_SERVICE_PROVIDER=mullvad
VPN_TYPE=wireguard
WIREGUARD_PRIVATE_KEY=your_private_key_here
WIREGUARD_ADDRESSES=your_address
SERVER_CITIES=Stockholm
```

For other providers and detailed configuration options, see the [Gluetun documentation](https://github.com/qdm12/gluetun-wiki)

## Cross-Seed Configuration

Cross-Seed automatically searches your indexers for cross-seeds of your existing torrents, helping you maintain better ratios and support the torrent ecosystem.

**Configuration File Location**: `./config/cross-seed/config.js`
**Documentation**: https://www.cross-seed.org/docs/basics/options

### Initial Setup

Cross-seed is pre-configured to work with qBittorrent, Sonarr, and Radarr automatically.

**⚠️ Important: You must configure indexers for cross-seed to work!**

1. **Configure Cross-Seed indexers**:
   - Edit `./config/cross-seed/config.js`
   - Get your Prowlarr API key from Prowlarr → Settings → General
   - Add your Prowlarr Torznab feeds to the `torznab` array:
     ```javascript
     torznab: [
         "http://prowlarr:9696/1/api?apikey=YOUR_PROWLARR_API_KEY",
         "http://prowlarr:9696/2/api?apikey=YOUR_PROWLARR_API_KEY",
     ],
     ```
   - Each number (1, 2, etc.) represents an indexer ID in Prowlarr
   - Find indexer IDs in Prowlarr → Indexers (hover over the Torznab feed icon)
   - **Full configuration options**: https://www.cross-seed.org/docs/basics/options

2. **Restart Cross-Seed**:
   ```bash
   docker restart cross-seed
   ```

3. **Verify it's working**:
   - Check logs: `docker logs cross-seed`
   - Look for: `[search] Found X cross seeds from Y original torrents`

4. **Monitor via Web UI** (optional):
   - Access at `http://localhost:2468`
   - Default API key is auto-generated, check with: `docker exec cross-seed cross-seed api-key`

### Key Configuration Options

- **Delay**: Time to wait before searching for cross-seeds (recommend 30+ seconds)
- **Action**: Choose "inject" to automatically add cross-seeds to qBittorrent
- **Duplicate Categories**: Organize cross-seeds with categories in qBittorrent
- **Search Cadence**: How often to search for new cross-seeds (e.g., daily)

See the [Cross-Seed documentation](https://cross-seed.org/) for detailed configuration options.

## Recyclarr Configuration

Recyclarr automatically syncs TRaSH guides to Sonarr and Radarr, providing optimal quality profiles, custom formats, and naming schemes.

### Initial Setup

1. **Create configuration file**:
   ```bash
   docker exec recyclarr recyclarr config create
   ```

2. **Edit the configuration**:
   - File location: `./config/recyclarr/recyclarr.yml`
   - Add your Sonarr/Radarr instances with API keys
   - Select which TRaSH guide templates to use

3. **Example configuration**:
   ```yaml
   sonarr:
     main:
       base_url: http://sonarr:8989
       api_key: YOUR_SONARR_API_KEY
       quality_definition:
         type: series
       custom_formats:
         - trash_ids:
             - EBC725268D687D588A20CBC5F97E538B  # x265

   radarr:
     main:
       base_url: http://radarr:7878
       api_key: YOUR_RADARR_API_KEY
       quality_definition:
         type: movie
       custom_formats:
         - trash_ids:
             - 496f355514737f7d83bf7aa4d24f8169  # TrueHD Atmos
   ```

4. **Run sync manually**:
   ```bash
   docker exec recyclarr recyclarr sync
   ```

5. **Automated syncing**:
   - Set up a cron job or use the built-in scheduler
   - Add to `recyclarr.yml`:
     ```yaml
     schedules:
       - cron: "0 5 * * *"  # Daily at 5 AM
     ```

**Documentation**: https://recyclarr.dev/

## Health Dashboard

Access the health monitoring dashboard at `http://localhost:3000`

**Features:**
- VPN connection status and egress IP
- Port forwarding status
- Service health checks (Sonarr, Radarr, etc.)
- qBittorrent stats (speed, torrents)
- Auto-refreshes every 3 seconds

### How It Works

The health server:
1. Auto-discovers service IPs from Docker containers
2. Connects directly via Docker network IPs (no auth needed)
3. Monitors VPN health and port forwarding
4. Checks qBittorrent egress IP to verify VPN routing

**Important**: Whitelist Docker network subnets in *arr apps and qBittorrent:
- `172.18.0.0/16` (default network)
- `172.19.0.0/16` (media network)

## Network Architecture

```
┌─────────────────────────────────────────┐
│          Host Network (LAN)             │
│  Ports exposed: 8080, 8989, 7878, etc. │
└────────────┬────────────────────────────┘
             │
    ┌────────┴────────┐
    │  Docker Bridge  │
    │   (default)     │
    └────┬───────┬────┘
         │       │
    ┌────▼──┐   │    ┌──────────────┐
    │Gluetun│───┼────│ Health Server│
    │ (VPN) │   │    │ (monitoring) │
    └───┬───┘   │    └──────────────┘
        │       │
   ┌────▼────┐  │
   │qBittor- │  │
   │ rent    │  │
   │(shared  │  │
   │ net)    │  │
   └─────────┘  │
                │
    ┌───────────▼──────────┐
    │   Docker Bridge      │
    │      (media)         │
    └─┬──────┬────┬────┬──┘
      │      │    │    │
   ┌──▼──┐┌─▼──┐┌▼──┐┌▼────────┐
   │Sonarr││Rad-││Pro││FlareSolv│
   │      ││arr ││wl.││err      │
   └──────┘└────┘└───┘└─────────┘
```

- **qBittorrent** shares Gluetun's network namespace → all traffic via VPN
- **Health Server** bridges both networks → can monitor all services
- **Media apps** on dedicated network → isolated from VPN

## Port Forwarding

The `pf-sync` container automatically:
1. Reads forwarded port from Gluetun (`/tmp/gluetun/forwarded_port`)
2. Updates qBittorrent listening port via API
3. Syncs every 30 seconds

Monitor in health dashboard to verify port forwarding is active.

## Maintenance

### View Logs
```bash
docker compose logs -f [service_name]
docker compose logs -f gluetun        # VPN logs
docker compose logs -f health-server  # Health checks
docker compose logs -f pf-sync        # Port forwarding
```

### Restart Services
```bash
docker compose restart [service_name]
docker compose restart              # Restart all
```

### Update Containers
Watchtower automatically updates containers with `com.centurylinklabs.watchtower.enable=true` label.

Manual update:
```bash
docker compose pull
docker compose up -d
```

### Check VPN Status
```bash
# Check VPN connection
docker exec gluetun cat /tmp/gluetun/ip

# Check forwarded port
docker exec gluetun cat /tmp/gluetun/forwarded_port

# Test egress IP
docker exec qbittorrent curl https://ifconfig.io
```

## Troubleshooting

### VPN Not Connecting
- Verify WireGuard credentials in `.env`
- Check Gluetun logs: `docker logs gluetun`
- Ensure `SERVER_COUNTRIES` or `SERVER_CITIES` is configured

### Port Forwarding Not Working
- Check if VPN provider supports port forwarding
- Verify `VPN_PORT_FORWARDING=on` in docker-compose.yml
- Check pf-sync logs: `docker logs pf-sync`

### Services Can't Be Reached
- Verify network configuration: `docker network inspect servarr_media`
- Check if containers are running: `docker compose ps`
- Verify port mappings in docker-compose.yml

### Health Dashboard Shows Errors
- Check Docker socket is mounted: `docker exec health-server ls -l /var/run/docker.sock`
- Check container logs: `docker logs health-server`
- Whitelist Docker subnets (172.18.0.0/16, 172.19.0.0/16) in service settings
- Docker GID is auto-detected by bootstrap.sh, but if you're running `docker compose` manually and get permission errors:
  ```bash
  # Find and set your docker GID
  export DOCKER_GID=$(getent group docker | cut -d: -f3)
  docker compose build health-server
  docker compose up -d health-server
  ```

### Directory Name Changed / Project Name Issues
- If you rename the project directory, service discovery may fail
- Set `COMPOSE_PROJECT_NAME=servarr` in `.env` to maintain consistent network names
- Or rebuild the health-server after renaming: `docker compose build health-server && docker compose up -d`

## Directory Structure

```
.
├── .env                    # Your configuration (create from .env.example)
├── .env.example           # Example configuration
├── .gitignore
├── bootstrap.sh           # Setup script
├── docker-compose.yml     # Main stack definition
├── config/                # Service configurations (auto-created)
│   ├── qbittorrent/
│   ├── sonarr/
│   ├── radarr/
│   ├── prowlarr/
│   └── bazarr/
└── server-health/         # Health monitoring service
    ├── Dockerfile
    ├── health-server.js
    └── package.json
```

## License

This setup is provided as-is for personal use.
