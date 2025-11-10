#!/usr/bin/env bash
set -euo pipefail

# Parse command line arguments
DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "=== DRY RUN MODE - No actual changes will be made ==="
  echo ""
fi

# Interactive configuration function
configure_env() {
  echo "=== Servarr Stack Configuration ==="
  echo ""

  # Auto-detect timezone
  if [ -f /etc/timezone ]; then
    DETECTED_TZ=$(cat /etc/timezone)
  elif [ -L /etc/localtime ]; then
    DETECTED_TZ=$(readlink /etc/localtime | sed 's|.*/zoneinfo/||')
  else
    DETECTED_TZ="UTC"
  fi

  # Basic settings
  read -p "Timezone (default: ${DETECTED_TZ}): " TZ
  TZ=${TZ:-${DETECTED_TZ}}

  read -p "User ID/PUID (default: 1000): " PUID
  PUID=${PUID:-1000}

  read -p "Group ID/PGID (default: 1001): " PGID
  PGID=${PGID:-1001}

  # Detect LAN subnets from common interfaces
  echo ""
  echo "Detecting LAN subnets..."
  DETECTED_SUBNETS=$(ip -4 route | grep -E "dev (eth[0-9]+|wlan[0-9]+|en[ops][0-9]+)" | grep -v "default" | grep -oP '^\K[0-9.]+/[0-9]+' | sort -u)

  if [ -n "$DETECTED_SUBNETS" ]; then
    echo "Detected subnets on your system:"
    select subnet in $DETECTED_SUBNETS "Enter manually"; do
      if [ "$subnet" = "Enter manually" ]; then
        read -p "Enter LAN subnet (e.g., 192.168.1.0/24): " LAN_SUBNET
      else
        LAN_SUBNET="$subnet"
      fi
      break
    done
  else
    read -p "LAN subnet (e.g., 192.168.1.0/24): " LAN_SUBNET
  fi

  read -p "Media directory path (default: /mnt/media): " MEDIA_DIR
  MEDIA_DIR=${MEDIA_DIR:-/mnt/media}

  echo ""
  echo "--- qBittorrent Configuration ---"
  read -p "qBittorrent WebUI port (default: 8080): " QBIT_WEBUI
  QBIT_WEBUI=${QBIT_WEBUI:-8080}

  echo ""
  echo "--- VPN Configuration (Optional) ---"
  echo ""
  echo "IMPORTANT: Not all VPN providers support port forwarding!"
  echo "  - Port forwarding is needed for optimal torrent performance"
  echo "  - Check with your provider before enabling VPN"
  echo "  - If unsure, you can disable VPN by answering 'n' below"
  echo ""
  read -p "Use VPN (Gluetun) for qBittorrent? (Y/n): " USE_VPN
  USE_VPN=${USE_VPN:-Y}

  if [[ "$USE_VPN" =~ ^[Yy]$ ]]; then
    USE_VPN=true

    echo ""
    echo "Gluetun supports many VPN providers. Common options:"
    echo "  - protonvpn"
    echo "  - nordvpn"
    echo "  - mullvad"
    echo "  - expressvpn"
    echo "  - surfshark"
    echo "  - purevpn"
    echo "  - privateinternetaccess"
    echo "(See https://github.com/qdm12/gluetun-wiki for full list)"
    echo ""
    read -p "VPN provider (default: protonvpn): " VPN_SERVICE_PROVIDER
    VPN_SERVICE_PROVIDER=${VPN_SERVICE_PROVIDER:-protonvpn}

    read -p "VPN type [wireguard/openvpn] (default: wireguard): " VPN_TYPE
    VPN_TYPE=${VPN_TYPE:-wireguard}

    read -p "VPN server country (default: Sweden): " SERVER_COUNTRIES
    SERVER_COUNTRIES=${SERVER_COUNTRIES:-Sweden}

    read -p "VPN server city (optional, default: Stockholm): " SERVER_CITIES
    SERVER_CITIES=${SERVER_CITIES:-Stockholm}

    echo ""
    echo "Enter your VPN credentials"
    echo "Note: Credential format varies by provider - consult Gluetun documentation"

    if [[ "$VPN_TYPE" == "wireguard" ]]; then
      read -sp "WireGuard Private Key: " WIREGUARD_PRIVATE_KEY
      echo ""
      read -p "WireGuard Address (e.g., 10.2.0.2/32, leave empty if not required): " WIREGUARD_ADDRESSES
    else
      read -p "OpenVPN Username: " OPENVPN_USER
      read -sp "OpenVPN Password: " OPENVPN_PASSWORD
      echo ""
    fi
  else
    USE_VPN=false
    VPN_SERVICE_PROVIDER=""
    VPN_TYPE=""
    SERVER_COUNTRIES=""
    SERVER_CITIES=""
    WIREGUARD_PRIVATE_KEY=""
    WIREGUARD_ADDRESSES=""
    OPENVPN_USER=""
    OPENVPN_PASSWORD=""
  fi

  echo ""
  echo "--- Service Ports (press Enter for defaults) ---"
  read -p "Sonarr port (default: 8989): " SONARR_PORT
  SONARR_PORT=${SONARR_PORT:-8989}

  read -p "Radarr port (default: 7878): " RADARR_PORT
  RADARR_PORT=${RADARR_PORT:-7878}

  read -p "Prowlarr port (default: 9696): " PROWLARR_PORT
  PROWLARR_PORT=${PROWLARR_PORT:-9696}

  read -p "Bazarr port (default: 6767): " BAZARR_PORT
  BAZARR_PORT=${BAZARR_PORT:-6767}

  read -p "FlareSolverr port (default: 8191): " FLARESOLVERR_PORT
  FLARESOLVERR_PORT=${FLARESOLVERR_PORT:-8191}

  read -p "Cross-Seed port (default: 2468): " CROSS_SEED_PORT
  CROSS_SEED_PORT=${CROSS_SEED_PORT:-2468}

  read -p "Health dashboard port (default: 3000): " HEALTH_PORT
  HEALTH_PORT=${HEALTH_PORT:-3000}

  # Auto-detect Docker GID
  DOCKER_GID=$(getent group docker | cut -d: -f3 2>/dev/null || echo "984")

  # Auto-detect project name from directory
  DETECTED_PROJECT_NAME=$(basename "$(pwd)")

  # Set defaults for any unset VPN variables to avoid unbound variable errors
  : ${VPN_SERVICE_PROVIDER:=}
  : ${VPN_TYPE:=}
  : ${SERVER_COUNTRIES:=}
  : ${SERVER_CITIES:=}
  : ${WIREGUARD_PRIVATE_KEY:=}
  : ${WIREGUARD_ADDRESSES:=}
  : ${OPENVPN_USER:=}
  : ${OPENVPN_PASSWORD:=}

  # Write .env file
  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would write to .env:"
    echo "---"
  fi

  ENV_CONTENT=$(cat << EOF
# Basics
TZ=${TZ}
PUID=${PUID}
PGID=${PGID}
LAN_SUBNET=${LAN_SUBNET}
MEDIA_DIR=${MEDIA_DIR}

# Docker Configuration (Optional - auto-detected by bootstrap.sh)
# Uncomment to override auto-detection:
# DOCKER_GID=${DOCKER_GID}

# Project name (auto-detected from directory: ${DETECTED_PROJECT_NAME})
COMPOSE_PROJECT_NAME=${DETECTED_PROJECT_NAME}

# qBittorrent Configuration
QBIT_WEBUI=${QBIT_WEBUI}

# VPN Configuration
USE_VPN=${USE_VPN}

# VPN Provider Configuration (only used if USE_VPN=true)
# See https://github.com/qdm12/gluetun-wiki for all supported providers
VPN_SERVICE_PROVIDER=${VPN_SERVICE_PROVIDER}
VPN_TYPE=${VPN_TYPE}

# Server selection (only used if USE_VPN=true)
SERVER_COUNTRIES=${SERVER_COUNTRIES}
SERVER_CITIES=${SERVER_CITIES}
# To pin a specific server hostname:
# SERVER_HOSTNAMES=se-41.protonvpn.net

# VPN Credentials (only used if USE_VPN=true, provider-specific)
WIREGUARD_PRIVATE_KEY=${WIREGUARD_PRIVATE_KEY}
WIREGUARD_ADDRESSES=${WIREGUARD_ADDRESSES}
OPENVPN_USER=${OPENVPN_USER}
OPENVPN_PASSWORD=${OPENVPN_PASSWORD}

# Service Ports
PROWLARR_PORT=${PROWLARR_PORT}
SONARR_PORT=${SONARR_PORT}
RADARR_PORT=${RADARR_PORT}
BAZARR_PORT=${BAZARR_PORT}
FLARESOLVERR_PORT=${FLARESOLVERR_PORT}
CROSS_SEED_PORT=${CROSS_SEED_PORT}
HEALTH_PORT=${HEALTH_PORT}

# Health Server Configuration
# Service IPs and ports are auto-discovered from Docker containers
# Whitelist these Docker network subnets in *arr apps and qBittorrent WebUI settings:
#   172.18.0.0/16 (default network)
#   172.19.0.0/16 (media network)
EOF
)

  if [ "$DRY_RUN" = true ]; then
    echo "$ENV_CONTENT"
    echo "---"
  else
    echo "$ENV_CONTENT" > .env
  fi

  echo ""
  if [ "$DRY_RUN" = false ]; then
    echo "✓ Configuration saved to .env"
  fi
  echo "✓ Auto-detected Docker GID: ${DOCKER_GID}"
  echo "✓ Auto-detected project name: ${DETECTED_PROJECT_NAME}"
  echo ""
}

# Check if .env exists
if [ ! -f .env ]; then
  echo "No .env file found. Starting interactive configuration..."
  echo ""
  configure_env
else
  echo "Found existing .env file."
  read -p "Do you want to reconfigure? (y/N): " RECONFIG
  if [[ "$RECONFIG" =~ ^[Yy]$ ]]; then
    configure_env
  fi
fi

# Source environment variables
set -a
source .env
set +a

# Set defaults for optional VPN variables to avoid unbound variable errors
: ${VPN_SERVICE_PROVIDER:=}
: ${VPN_TYPE:=}
: ${SERVER_COUNTRIES:=}
: ${SERVER_CITIES:=}
: ${WIREGUARD_PRIVATE_KEY:=}
: ${WIREGUARD_ADDRESSES:=}
: ${OPENVPN_USER:=}
: ${OPENVPN_PASSWORD:=}

# Auto-detect Docker GID if not set in .env
if [ -z "${DOCKER_GID:-}" ]; then
  DETECTED_GID=$(getent group docker | cut -d: -f3 2>/dev/null || echo "984")
  export DOCKER_GID="$DETECTED_GID"
  echo "Auto-detected Docker GID: $DOCKER_GID"
  if [ "$DOCKER_GID" != "984" ]; then
    echo "Note: Your Docker GID differs from default (984). Using $DOCKER_GID"
  fi
fi

# Create config directories
if [ "$DRY_RUN" = true ]; then
  echo "[DRY RUN] Would create config directories: config/{qbittorrent,prowlarr,sonarr,radarr,bazarr,cross-seed,recyclarr}"
else
  mkdir -p config/{qbittorrent,prowlarr,sonarr,radarr,bazarr,cross-seed,recyclarr}
  echo "✓ Created config directories"
fi

# Create media directories
echo ""
if [ "$DRY_RUN" = true ]; then
  echo "[DRY RUN] Would create media directories at ${MEDIA_DIR}:"
  echo "  - ${MEDIA_DIR}/downloads/incomplete"
  echo "  - ${MEDIA_DIR}/downloads/completed"
  echo "  - ${MEDIA_DIR}/tv"
  echo "  - ${MEDIA_DIR}/movies"
  echo "[DRY RUN] Would run: sudo chown -R ${PUID}:${PGID} ${MEDIA_DIR}"
else
  echo "Creating media directories at ${MEDIA_DIR}..."
  sudo mkdir -p "${MEDIA_DIR}"/{downloads/{incomplete,completed,cross-seeds},tv,movies}
  sudo chown -R "${PUID}:${PGID}" "${MEDIA_DIR}"
  echo "✓ Created media directories"
fi

# Fix config directory permissions
if [ "$DRY_RUN" = false ]; then
  echo "Fixing config directory permissions..."
  sudo chown -R "${PUID}:${PGID}" config/
  echo "✓ Fixed config permissions"
fi

# Pull and start services
echo ""
if [ "$DRY_RUN" = true ]; then
  echo "[DRY RUN] Would run: COMPOSE_PROFILES=vpn docker compose down"
  echo "[DRY RUN] Would run: COMPOSE_PROFILES=no-vpn docker compose down"
  echo "[DRY RUN] Would run: docker compose down --remove-orphans"
  if [ "$USE_VPN" = "true" ]; then
    echo "[DRY RUN] Would run: COMPOSE_PROFILES=vpn docker compose pull"
    echo "[DRY RUN] Would run: COMPOSE_PROFILES=vpn docker compose up -d"
  else
    echo "[DRY RUN] Would run: COMPOSE_PROFILES=no-vpn docker compose pull"
    echo "[DRY RUN] Would run: COMPOSE_PROFILES=no-vpn docker compose up -d"
  fi
  echo "[DRY RUN] Would configure qBittorrent credentials"
  echo ""
  echo "=== DRY RUN COMPLETE ==="
  echo "No actual changes were made. To run for real, execute without --dry-run"
else
  # Stop and remove any existing containers from both profiles
  echo "Stopping existing containers..."
  COMPOSE_PROFILES=vpn docker compose down 2>/dev/null || true
  COMPOSE_PROFILES=no-vpn docker compose down 2>/dev/null || true

  # Also remove orphan containers that might conflict
  docker compose down --remove-orphans 2>/dev/null || true

  echo "Rebuilding health-server with current configuration..."
  docker compose build health-server

  echo "Pulling Docker images..."
  if [ "$USE_VPN" = "true" ]; then
    echo "Starting with VPN enabled..."
    COMPOSE_PROFILES=vpn docker compose pull
    COMPOSE_PROFILES=vpn docker compose up -d
  else
    echo "Starting without VPN..."
    COMPOSE_PROFILES=no-vpn docker compose pull
    COMPOSE_PROFILES=no-vpn docker compose up -d
  fi

  # Configure qBittorrent authentication bypass
  echo ""
  echo "Configuring qBittorrent authentication bypass..."

  # Wait for qBittorrent to start and extract temporary credentials from logs
  QBIT_URL="http://localhost:${QBIT_WEBUI:-8080}"
  echo -n "Waiting for qBittorrent to start"

  TEMP_USER=""
  TEMP_PASS=""

  for i in {1..60}; do
    # Check if qBittorrent API is responding
    if curl -s -m 2 "$QBIT_URL/api/v2/app/version" > /dev/null 2>&1; then
      echo " ready!"

      # Extract temporary credentials from logs
      LOGS=$(docker logs qbittorrent 2>&1 | tail -50)
      TEMP_USER=$(echo "$LOGS" | grep -oP "The WebUI administrator username is: \K\w+")
      TEMP_PASS=$(echo "$LOGS" | grep -oP "A temporary password is provided for this session: \K\S+")

      break
    fi
    echo -n "."
    sleep 1
  done
  echo ""

  # Try to login with temporary or default credentials
  echo "Enabling authentication bypass..."
  COOKIE_JAR=$(mktemp)
  LOGIN_SUCCESS=false

  # Try temporary credentials first (newer qBittorrent versions)
  if [ -n "$TEMP_USER" ] && [ -n "$TEMP_PASS" ]; then
    echo "Found temporary credentials in logs (username: $TEMP_USER, password: $TEMP_PASS)"
    echo "Note: Use these credentials to login to qBittorrent WebUI at http://localhost:${QBIT_WEBUI}"
    if curl -s -c "$COOKIE_JAR" \
      -H "Referer: $QBIT_URL/" \
      -H "Origin: $QBIT_URL" \
      --data "username=${TEMP_USER}&password=${TEMP_PASS}" \
      "$QBIT_URL/api/v2/auth/login" | grep -q "Ok"; then
      LOGIN_SUCCESS=true
    fi
  fi

  # Fallback to default credentials (older qBittorrent versions)
  if [ "$LOGIN_SUCCESS" = false ]; then
    if curl -s -c "$COOKIE_JAR" \
      -H "Referer: $QBIT_URL/" \
      -H "Origin: $QBIT_URL" \
      --data "username=admin&password=adminadmin" \
      "$QBIT_URL/api/v2/auth/login" | grep -q "Ok"; then
      LOGIN_SUCCESS=true
      echo "Using default credentials (admin:adminadmin)"
    fi
  fi

  # Enable authentication bypass if we successfully logged in
  if [ "$LOGIN_SUCCESS" = true ]; then
    echo "Enabling authentication bypass for localhost and LAN subnets..."

    # Enable bypass for localhost and configure whitelist
    curl -s -b "$COOKIE_JAR" \
      -H "Referer: $QBIT_URL/" \
      -H "Origin: $QBIT_URL" \
      -H "Content-Type: application/x-www-form-urlencoded" \
      --data-urlencode "json={\"web_ui_address\":\"*\",\"web_ui_host_header_validation_enabled\":false,\"bypass_local_auth\":true,\"bypass_auth_subnet_whitelist_enabled\":true,\"bypass_auth_subnet_whitelist\":\"127.0.0.1/32\n172.18.0.0/16\n172.19.0.0/16\n${LAN_SUBNET}\"}" \
      "$QBIT_URL/api/v2/app/setPreferences" > /dev/null

    echo "✓ Authentication bypass enabled for:"
    echo "  - Localhost (127.0.0.1)"
    echo "  - Docker networks (172.18.0.0/16, 172.19.0.0/16)"
    echo "  - LAN subnet (${LAN_SUBNET})"
  else
    echo "Warning: Could not login to qBittorrent to configure authentication bypass"
    echo "You may need to manually configure authentication bypass in the qBittorrent WebUI"
  fi

  rm -f "$COOKIE_JAR"

  echo ""
  echo "Setup complete!"
  echo ""
  if [ -n "$TEMP_USER" ] && [ -n "$TEMP_PASS" ]; then
    echo "qBittorrent temporary login credentials:"
    echo "  Username: $TEMP_USER"
    echo "  Password: $TEMP_PASS"
    echo "  URL: http://localhost:${QBIT_WEBUI:-8080}"
    echo ""
    echo "IMPORTANT: Change your password after first login!"
    echo ""
  fi
  echo "Service URLs:"
  echo "  Health dashboard: http://localhost:${HEALTH_PORT:-3000}"
  echo "  qBittorrent: http://localhost:${QBIT_WEBUI:-8080}"
  echo "  Sonarr: http://localhost:${SONARR_PORT:-8989}"
  echo "  Radarr: http://localhost:${RADARR_PORT:-7878}"
  echo "  Prowlarr: http://localhost:${PROWLARR_PORT:-9696}"
  echo "  Bazarr: http://localhost:${BAZARR_PORT:-6767}"
  echo "  Cross-Seed: http://localhost:${CROSS_SEED_PORT:-2468}"
  echo ""
  echo "================================================================"
  echo "Next Steps: Configure Your Services"
  echo "================================================================"
  echo ""
  echo "1. PROWLARR - Setup Indexers"
  echo "   • Open http://localhost:${PROWLARR_PORT:-9696}"
  echo "   • Add your indexers (Indexers → Add Indexer)"
  echo "   • Copy your Prowlarr API key (Settings → General)"
  echo ""
  echo "2. SONARR & RADARR - Connect to Prowlarr & qBittorrent"
  echo "   • Open Sonarr: http://localhost:${SONARR_PORT:-8989}"
  echo "   • Open Radarr: http://localhost:${RADARR_PORT:-7878}"
  echo "   • In each service:"
  echo "     - Add Prowlarr: Settings → Indexers → Add → Prowlarr"
  echo "       URL: http://prowlarr:9696"
  echo "       API Key: (from Prowlarr)"
  echo "     - Add qBittorrent: Settings → Download Clients → Add → qBittorrent"
  echo "       Host: qbittorrent (or gluetun if using VPN)"
  echo "       Port: ${QBIT_WEBUI:-8080}"
  echo "     - Configure paths: Settings → Media Management"
  echo "       TV: ${MEDIA_DIR}/tv"
  echo "       Movies: ${MEDIA_DIR}/movies"
  echo ""
  echo "3. BAZARR - Connect to Sonarr & Radarr"
  echo "   • Open http://localhost:${BAZARR_PORT:-6767}"
  echo "   • Settings → Sonarr/Radarr → Add instances"
  echo "   • Configure subtitle providers"
  echo ""
  echo "4. CROSS-SEED - Configure Indexers"
  echo "   • Edit: ./config/cross-seed/config.js"
  echo "   • Add Prowlarr Torznab feeds to 'torznab' array"
  echo "   • Restart: docker restart cross-seed"
  echo "   • Guide: https://www.cross-seed.org/docs/basics/options"
  echo ""
  echo "5. RECYCLARR - Sync TRaSH Guides (Optional)"
  echo "   • Edit: ./config/recyclarr/recyclarr.yml"
  echo "   • Add Sonarr/Radarr API keys and select guide templates"
  echo "   • Run sync: docker exec recyclarr recyclarr sync"
  echo "   • Guide: https://recyclarr.dev/"
  echo ""
  echo "6. AUTHENTICATION BYPASS (Important!)"
  echo "   • In each *arr app: Settings → General → Security"
  echo "   • Add to 'Authentication Required' whitelist:"
  echo "     - 172.18.0.0/16 (default Docker network)"
  echo "     - 172.19.0.0/16 (media network)"
  echo "   • This allows health monitoring and service communication"
  echo ""
  echo "================================================================"
  echo "For detailed instructions, see README.md"
  echo "================================================================"
fi
