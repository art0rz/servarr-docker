#!/usr/bin/env bash

# Utility functions shared across scripts

# Auto-detect timezone
detect_timezone() {
  if [ -f /etc/timezone ]; then
    cat /etc/timezone
  elif [ -L /etc/localtime ]; then
    readlink /etc/localtime | sed 's|.*/zoneinfo/||'
  else
    echo "UTC"
  fi
}

# Auto-detect Docker GID
detect_docker_gid() {
  getent group docker | cut -d: -f3 2>/dev/null || echo "984"
}

# Detect LAN subnets from common interfaces
detect_lan_subnets() {
  ip -4 route | grep -E "dev (eth[0-9]+|wlan[0-9]+|en[ops][0-9]+)" | grep -v "default" | grep -oP '^\K[0-9.]+/[0-9]+' | sort -u
}

# Set defaults for optional VPN variables to avoid unbound variable errors
set_vpn_defaults() {
  : "${VPN_SERVICE_PROVIDER:=}"
  : "${VPN_TYPE:=}"
  : "${SERVER_COUNTRIES:=}"
  : "${SERVER_CITIES:=}"
  : "${WIREGUARD_PRIVATE_KEY:=}"
  : "${WIREGUARD_ADDRESSES:=}"
  : "${OPENVPN_USER:=}"
  : "${OPENVPN_PASSWORD:=}"
}
