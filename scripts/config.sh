#!/usr/bin/env bash

# Interactive configuration function
configure_env() {
  echo "=== Servarr Stack Configuration ==="
  echo ""

  # Auto-detect timezone
  DETECTED_TZ=$(detect_timezone)

  # Basic settings
  read -r -p "Timezone (default: ${DETECTED_TZ}): " TZ
  TZ=${TZ:-${DETECTED_TZ}}

  read -r -p "User ID/PUID (default: 1000): " PUID
  PUID=${PUID:-1000}

  read -r -p "Group ID/PGID (default: 1001): " PGID
  PGID=${PGID:-1001}

  # Detect LAN subnets from common interfaces
  echo ""
  echo "Detecting LAN subnets..."
  DETECTED_SUBNETS=$(detect_lan_subnets)

  if [ -n "$DETECTED_SUBNETS" ]; then
    echo "Detected subnets on your system:"
    select subnet in $DETECTED_SUBNETS "Enter manually"; do
      if [ "$subnet" = "Enter manually" ]; then
        read -r -p "Enter LAN subnet (e.g., 192.168.1.0/24): " LAN_SUBNET
      else
        LAN_SUBNET="$subnet"
      fi
      break
    done
  else
    read -r -p "LAN subnet (e.g., 192.168.1.0/24): " LAN_SUBNET
  fi

  read -r -p "Media directory path (default: /mnt/media): " MEDIA_DIR
  MEDIA_DIR=${MEDIA_DIR:-/mnt/media}

  echo ""
  echo "--- qBittorrent Configuration ---"
  read -r -p "qBittorrent WebUI port (default: 8080): " QBIT_WEBUI
  QBIT_WEBUI=${QBIT_WEBUI:-8080}

  echo ""
  echo "--- VPN Configuration (Optional) ---"
  echo ""
  echo "IMPORTANT: Not all VPN providers support port forwarding!"
  echo "  - Port forwarding is needed for optimal torrent performance"
  echo "  - Check with your provider before enabling VPN"
  echo "  - If unsure, you can disable VPN by answering 'n' below"
  echo ""
  read -r -p "Use VPN (Gluetun) for qBittorrent? (Y/n): " USE_VPN
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
    read -r -p "VPN provider (default: protonvpn): " VPN_SERVICE_PROVIDER
    VPN_SERVICE_PROVIDER=${VPN_SERVICE_PROVIDER:-protonvpn}

    read -r -p "VPN type [wireguard/openvpn] (default: wireguard): " VPN_TYPE
    VPN_TYPE=${VPN_TYPE:-wireguard}

    read -r -p "VPN server country (default: Sweden): " SERVER_COUNTRIES
    SERVER_COUNTRIES=${SERVER_COUNTRIES:-Sweden}

    read -r -p "VPN server city (optional, default: Stockholm): " SERVER_CITIES
    SERVER_CITIES=${SERVER_CITIES:-Stockholm}

    echo ""
    echo "Enter your VPN credentials"
    echo "Note: Credential format varies by provider - consult Gluetun documentation"

    if [[ "$VPN_TYPE" == "wireguard" ]]; then
      read -r -sp "WireGuard Private Key: " WIREGUARD_PRIVATE_KEY
      echo ""
      read -r -p "WireGuard Address (e.g., 10.2.0.2/32, leave empty if not required): " WIREGUARD_ADDRESSES
    else
      read -r -p "OpenVPN Username: " OPENVPN_USER
      read -r -sp "OpenVPN Password: " OPENVPN_PASSWORD
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
  read -r -p "Sonarr port (default: 8989): " SONARR_PORT
  SONARR_PORT=${SONARR_PORT:-8989}

  read -r -p "Radarr port (default: 7878): " RADARR_PORT
  RADARR_PORT=${RADARR_PORT:-7878}

  read -r -p "Prowlarr port (default: 9696): " PROWLARR_PORT
  PROWLARR_PORT=${PROWLARR_PORT:-9696}

  read -r -p "Bazarr port (default: 6767): " BAZARR_PORT
  BAZARR_PORT=${BAZARR_PORT:-6767}

  read -r -p "FlareSolverr port (default: 8191): " FLARESOLVERR_PORT
  FLARESOLVERR_PORT=${FLARESOLVERR_PORT:-8191}

  read -r -p "Cross-Seed port (default: 2468): " CROSS_SEED_PORT
  CROSS_SEED_PORT=${CROSS_SEED_PORT:-2468}

  read -r -p "Health dashboard port (default: 3000): " HEALTH_PORT
  HEALTH_PORT=${HEALTH_PORT:-3000}

  # Auto-detect Docker GID
  DOCKER_GID=$(detect_docker_gid)

  # Auto-detect project name from directory
  DETECTED_PROJECT_NAME=$(basename "$(pwd)")

  # Set defaults for any unset VPN variables to avoid unbound variable errors
  set_vpn_defaults

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
