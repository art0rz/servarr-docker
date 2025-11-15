# Servarr Bootstrap

Automated Docker Compose stack for qBittorrent, the Arr suite, Gluetun VPN, pf-sync port forwarding, Cross-Seed, and a health dashboard. The `./bootstrap.sh` script provisions everything with sensible defaults, handles port forwarding, and exposes a Rich CLI with progress tables.

---

## Highlights

- **Opinionated automation** – Single `./bootstrap.sh` run handles config prompts, directory setup, Docker orchestration, integrations, and a final sanity scan (also available via `./bootstrap.sh check`).
- **VPN-aware torrenting** – qBittorrent lives behind Gluetun; pf-sync reads Gluetun’s forwarded port and updates qBittorrent automatically.
- **Arr ecosystem** – Sonarr, Radarr, Prowlarr, Bazarr, Recyclarr, and Cross-Seed are wired together out of the box.
- **Health monitoring** – Health server shows container status, VPN info, and forwarded-port parity via a web dashboard.
- **Developer-friendly** – Rich progress display, Vagrant dev environment, auto-detected Docker GID, and an idempotent setup flow.

---

## Service Map

| Service             | Purpose                              | Default Port(s) |
|---------------------|--------------------------------------|-----------------|
| Gluetun             | VPN gateway                          | 8080 (qBit UI)  |
| qBittorrent (VPN)   | Torrent client (LAN via Gluetun)     | 8080            |
| Sonarr              | Series automation                    | 8989            |
| Radarr              | Movie automation                     | 7878            |
| Prowlarr            | Indexer aggregator                   | 9696            |
| Bazarr              | Subtitle automation                  | 6767            |
| Cross-Seed          | Torrent cross-seeding                | 2468            |
| Recyclarr           | TRaSH guides sync                    | -               |
| FlareSolverr        | Cloudflare/DDoS bypass               | 8191            |
| Health Server       | Dashboard + readiness probes         | 3000            |
| Watchtower          | Container updates                    | -               |
| pf-sync             | Gluetun forwarded-port synchronizer  | (internal)      |

Host port forwarding is configurable via `.env`; the Vagrant VM also forwards each service to high host ports (see `Vagrantfile`).

---

## Quick Start (Native)

1. **Install dependencies**
   - Docker (with Compose plugin)
   - Git
   - Optional: `python3-venv` if you plan to run tests locally

2. **Clone + bootstrap**
   ```bash
   git clone https://github.com/your-org/servarr.git
   cd servarr
   chmod +x bootstrap.sh
   ./bootstrap.sh
   ```

3. **Follow the prompts**
   - Storage path (`MEDIA_DIR`), PUID/PGID, timezone
   - VPN provider, credentials, toggle for WireGuard/OpenVPN fields
   - Docker group GID auto-detected for the health server
   - Ports, pf-sync, and pf health check

4. **Let the script run**
   - Directory + permission setup → Docker orchestration (with live table) → integrations → final sanity scan + health summary (re-run later via `./bootstrap.sh check`).

5. **Open services**
   - `http://localhost:8989` (Sonarr), `http://localhost:7878` (Radarr), `http://localhost:9696` (Prowlarr), `http://localhost:6767` (Bazarr), `http://localhost:2468` (Cross-Seed), `http://localhost:8080` (qBit via Gluetun), `http://localhost:3000` (health dashboard).

> Tip: Use the same credentials you entered in the wizard for Sonarr/Radarr/Prowlarr/Bazarr/qBittorrent.

---

## Quick Start (Vagrant Sandbox)

Use the Vagrant VM to test fresh installs without touching your host:

```bash
vagrant up
# First boot installs Docker, syncs repo, restores cached venv if available

vagrant ssh
cd /home/vagrant/servarr
./bootstrap.sh clean -y && ./bootstrap.sh
```

Convenience provisioners (run from host):

| Command                              | Description                                      |
|--------------------------------------|--------------------------------------------------|
| `vagrant provision --bootstrap:run`  | Run `./bootstrap.sh` inside the VM               |
| `vagrant provision --bootstrap:clean`| Run `./bootstrap.sh clean --yes --purge-*`       |
| `vagrant provision --bootstrap:dry-run` | Dry-run bootstrap (no writes)                 |
| `vagrant provision --stack:ps`       | Show container status (`docker compose ps`)      |

Ports are forwarded to the host (e.g., health: `localhost:33000`, qBit: `localhost:38080`). See `docs/vagrant.md` for details.

---

## Configuration Notes

- **`.env`** is created/updated by the wizard; rerunning `./bootstrap.sh` re-prompts only for missing values.
- **VPN**:
  - WireGuard prompts: private key, interface CIDR, optional endpoint overrides.
  - OpenVPN prompts: username/password only.
  - `USE_VPN=false` launches qBittorrent outside Gluetun while keeping the Arr stack untouched.
- **pf-sync** keeps qBittorrent’s listen port aligned with Gluetun’s forwarded port. Health dashboard warns if they diverge.
- **Cross-Seed**, **Recyclarr**, and **Bazarr** integrations are automatic; no manual config file editing required.
- **Health server** runs with the detected Docker GID so it can inspect containers via `/var/run/docker.sock`.

Update any setting by editing `.env` and rerunning the bootstrapper (changes are idempotent).

---

## Service Access & Credentials

| Service      | URL                   | Notes                                             |
|--------------|-----------------------|---------------------------------------------------|
| Sonarr       | `http://localhost:8989` | Uses shared username/password                     |
| Radarr       | `http://localhost:7878` | Uses shared username/password                     |
| Prowlarr     | `http://localhost:9696` | Uses shared username/password                     |
| Bazarr       | `http://localhost:6767` | Uses shared username/password                     |
| qBittorrent  | `http://localhost:8080` | Credentials synced during bootstrap               |
| Cross-Seed   | `http://localhost:2468` | API key printed in logs                           |
| Health       | `http://localhost:3000` | Shows service status, VPN info, pf-sync check     |

For Vagrant, replace `localhost:<port>` with the forwarded host ports listed in the `Vagrantfile`.

---

## Standalone Sanity Check

Use the built-in check command to rerun readiness diagnostics without touching containers:

```bash
./bootstrap.sh check
```

It hydrates the current `.env`, verifies Docker/Compose availability, ensures config directories exist, and probes Arr/qBittorrent/Bazarr/Prowlarr HTTP endpoints. Failures are summarized in the Rich table; details live in `logs/bootstrap-latest.log`.

---

## Testing

A small unit suite validates the env wizard:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m unittest tests/test_env_setup
```

The health server (Node) can be tested via `npm test` inside `server-health/` (optional).

---

## Troubleshooting

- **pf-sync shows “container not found”**: ensure `/gluetun/tmp/gluetun/forwarded_port` is mounted (see compose volume `gluetun-tmp`).
- **Health server build fails with “gid in use”**: rerun the bootstrapper to refresh `.env` with the detected `DOCKER_GID` and rebuild `health-server`.
- **Bootstrap fails on `docker compose down` warnings**: warnings about unset VPN vars are safe; errors usually mean Docker daemon perms.
- **Vagrant provisioning fails**: run `vagrant rsync` to sync latest repo changes, especially Dockerfiles and `.env` defaults.

Check the latest log (`logs/bootstrap-latest.log`) for detailed stack traces; re-run failed commands manually if needed.

---

## Contributing

Issues and PRs are welcome. Please:

1. Run `python -m unittest tests/test_env_setup`.
2. If Vagrant changes are involved, verify with `vagrant up && vagrant provision --bootstrap:run`.
3. Describe the change and update docs (`README.md`, `docs/vagrant.md`, etc.) as appropriate.

---

## License

MIT. See `LICENSE` for details.

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

## Service Configuration Guide

After running the bootstrap script, follow these steps to configure all services to work together:

### 1. Configure Prowlarr (Indexer Manager)

1. Open Prowlarr at `http://localhost:9696`
2. Add your indexers:
   - Go to **Indexers** → **Add Indexer**
   - Search for and add your preferred torrent indexers
   - Configure each with your credentials/API keys
3. Copy your Prowlarr API key:
   - Go to **Settings** → **General**
   - Copy the **API Key** (you'll need this for other services)

### 2. Configure Sonarr (TV Shows)

1. Open Sonarr at `http://localhost:8989`

2. **Add Prowlarr as indexer source:**
   - Go to **Settings** → **Indexers** → **Add** → **Prowlarr**
   - **Prowlarr Server**: `http://prowlarr:9696`
   - **API Key**: (paste from Prowlarr)
   - **Sync Categories**: TV (default)
   - Click **Test** then **Save**

3. **Add qBittorrent as download client:**
   - Go to **Settings** → **Download Clients** → **Add** → **qBittorrent**
   - **Host**: `qbittorrent` (or `gluetun` if using VPN)
   - **Port**: `8080`
   - **Category**: `tv` (recommended)
   - Click **Test** then **Save**

4. **Configure media paths:**
   - Go to **Settings** → **Media Management**
   - Enable **Show Advanced**
   - **Root Folder**: Add `/mnt/media/tv` (or your `MEDIA_DIR/tv`)
   - Configure naming, permissions, and import settings

5. **Whitelist Docker networks** (for health monitoring):
   - Go to **Settings** → **General** → **Security**
   - **Authentication**: Required
   - **IP Addresses Whitelist**: Add `172.18.0.0/16,172.19.0.0/16`

### 3. Configure Radarr (Movies)

1. Open Radarr at `http://localhost:7878`

2. **Add Prowlarr as indexer source:**
   - Go to **Settings** → **Indexers** → **Add** → **Prowlarr**
   - **Prowlarr Server**: `http://prowlarr:9696`
   - **API Key**: (paste from Prowlarr)
   - **Sync Categories**: Movies (default)
   - Click **Test** then **Save**

3. **Add qBittorrent as download client:**
   - Go to **Settings** → **Download Clients** → **Add** → **qBittorrent**
   - **Host**: `qbittorrent` (or `gluetun` if using VPN)
   - **Port**: `8080`
   - **Category**: `movies` (recommended)
   - Click **Test** then **Save**

4. **Configure media paths:**
   - Go to **Settings** → **Media Management**
   - Enable **Show Advanced**
   - **Root Folder**: Add `/mnt/media/movies` (or your `MEDIA_DIR/movies`)
   - Configure naming, permissions, and import settings

5. **Whitelist Docker networks** (for health monitoring):
   - Go to **Settings** → **General** → **Security**
   - **Authentication**: Required
   - **IP Addresses Whitelist**: Add `172.18.0.0/16,172.19.0.0/16`

### 4. Configure Bazarr (Subtitles)

1. Open Bazarr at `http://localhost:6767`

2. **Add Sonarr:**
   - Go to **Settings** → **Sonarr**
   - **Enabled**: Yes
   - **Address**: `http://sonarr:8989`
   - **API Key**: (from Sonarr → Settings → General)
   - Click **Test** then **Save**

3. **Add Radarr:**
   - Go to **Settings** → **Radarr**
   - **Enabled**: Yes
   - **Address**: `http://radarr:7878`
   - **API Key**: (from Radarr → Settings → General)
   - Click **Test** then **Save**

4. **Configure subtitle providers:**
   - Go to **Settings** → **Providers**
   - Add your preferred subtitle providers (OpenSubtitles, Subscene, etc.)
   - Configure languages and filters

### 5. Configure qBittorrent

1. Open qBittorrent at `http://localhost:8080`
   - Use the temporary credentials shown in bootstrap output (if first time)
   - Or access without auth from localhost/LAN (auth bypass is enabled)

2. **Configure categories** (optional but recommended):
   - Go to **Settings** → **Downloads**
   - **Default Save Path**: `/mnt/media/downloads/completed`
   - **Category paths**:
     - `tv`: `/mnt/media/downloads/completed/tv`
     - `movies`: `/mnt/media/downloads/completed/movies`

3. **Authentication bypass is pre-configured** for:
   - Localhost (127.0.0.1)
   - Docker networks (172.18.0.0/16, 172.19.0.0/16)
   - LAN subnet (configured during bootstrap)

### 6. Configure Cross-Seed

See the [Cross-Seed Configuration](#cross-seed-configuration) section above for detailed setup.

**Quick steps:**
1. Edit `./config/cross-seed/config.js`
2. Add Prowlarr Torznab feeds to the `torznab` array
3. Restart: `docker restart cross-seed`

### 7. Configure Recyclarr (Optional)

See the [Recyclarr Configuration](#recyclarr-configuration) section above for detailed setup.

**Quick steps:**
1. Edit `./config/recyclarr/recyclarr.yml`
2. Add Sonarr/Radarr API keys
3. Select TRaSH guide templates
4. Run: `docker exec recyclarr recyclarr sync`

### Important Notes

- **Container Names**: When configuring services to talk to each other, always use container names (e.g., `http://sonarr:8989`) instead of `localhost`
- **Docker Networks**: The media network allows all *arr services to communicate
- **VPN Configuration**: If using VPN, qBittorrent is accessible via the `gluetun` container name
- **Authentication**: Docker network whitelisting allows services to communicate without authentication while still protecting external access

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
