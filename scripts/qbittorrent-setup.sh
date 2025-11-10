#!/usr/bin/env bash

# qBittorrent configuration

configure_qbittorrent() {
  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would configure qBittorrent credentials"
    return 0
  fi

  echo ""
  echo "Configuring qBittorrent authentication bypass..."

  # Wait for qBittorrent to start and extract temporary credentials from logs
  QBIT_URL="http://localhost:${QBIT_WEBUI:-8080}"
  echo -n "Waiting for qBittorrent to start"

  TEMP_USER=""
  TEMP_PASS=""

  for _ in {1..60}; do
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
}

print_completion_message() {
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
}
