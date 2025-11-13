#!/usr/bin/env bash
set -euo pipefail

# Parse command line arguments
DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "=== DRY RUN MODE - No actual changes will be made ==="
  echo ""
fi

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source utility functions
# shellcheck source=scripts/utils.sh
source "${SCRIPT_DIR}/scripts/utils.sh"

# Source other modules
# shellcheck source=scripts/config.sh
source "${SCRIPT_DIR}/scripts/config.sh"
# shellcheck source=scripts/setup.sh
source "${SCRIPT_DIR}/scripts/setup.sh"
# shellcheck source=scripts/docker.sh
source "${SCRIPT_DIR}/scripts/docker.sh"
# shellcheck source=scripts/qbittorrent-setup.sh
source "${SCRIPT_DIR}/scripts/qbittorrent-setup.sh"

# Check if .env exists
if [ ! -f .env ]; then
  echo "No .env file found. Starting interactive configuration..."
  echo ""
  configure_env
else
  echo "Found existing .env file."
  read -r -p "Do you want to reconfigure? (y/N): " RECONFIG
  if [[ "$RECONFIG" =~ ^[Yy]$ ]]; then
    configure_env
  fi
fi

# Source environment variables
set -a
# shellcheck source=.env
source .env
set +a

# Set defaults for optional VPN variables to avoid unbound variable errors
set_vpn_defaults

# Auto-detect Docker GID if not set in .env
if [ -z "${DOCKER_GID:-}" ]; then
  DETECTED_GID=$(detect_docker_gid)
  export DOCKER_GID="$DETECTED_GID"
  echo "Auto-detected Docker GID: $DOCKER_GID"
  if [ "$DOCKER_GID" != "984" ]; then
    echo "Note: Your Docker GID differs from default (984). Using $DOCKER_GID"
  fi
fi

# Setup directories
setup_directories

# Start services
start_services

# Configure qBittorrent
configure_qbittorrent

# Print completion message
if [ "$DRY_RUN" = true ]; then
  echo ""
  echo "=== DRY RUN COMPLETE ==="
  echo "No actual changes were made. To run for real, execute without --dry-run"
else
  print_completion_message
fi
