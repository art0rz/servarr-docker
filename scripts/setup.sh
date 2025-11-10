#!/usr/bin/env bash

# Setup directories and permissions

setup_directories() {
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
}
