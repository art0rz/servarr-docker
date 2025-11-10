#!/usr/bin/env bash

# Docker operations

start_services() {
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
  fi
}
