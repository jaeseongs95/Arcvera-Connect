#!/usr/bin/env bash
set -euo pipefail

# OpenDIY Remote 1:1 Relay — One-Click VPS Installer (Ubuntu / Debian)
# Usage:
#   curl -fsSL https://github.com/jaeseongs95/opendiy-remote/releases/download/v1.0.0/install-relay.sh | bash

VERSION="${OPENDIY_REMOTE_VERSION:-v1.0.0}"
PORT="${OPENDIY_REMOTE_PORT:-3210}"
BIND_HOST="${OPENDIY_REMOTE_BIND_HOST:-0.0.0.0}"
INSTALL_DIR="${OPENDIY_REMOTE_DIR:-$HOME/opendiy-remote}"
SERVICE_NAME="opendiy-remote"
BUNDLE_URL="https://github.com/jaeseongs95/opendiy-remote/releases/download/${VERSION}/opendiy-remote-${VERSION}-relay-bundle.tar.gz"

echo "==> [1/4] Checking Node.js (>= 22)..."
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${NODE_MAJOR}" -ge 22 ]; then
    NEED_NODE=0
    echo "    Found Node.js $(node -v)"
  fi
fi

if [ "${NEED_NODE}" -eq 1 ]; then
  echo "    Installing Node.js 22 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
  echo "    Installed Node.js $(node -v)"
fi

echo "==> [2/4] Downloading & extracting OpenDIY Remote (${VERSION}) to ${INSTALL_DIR}..."
mkdir -p "${INSTALL_DIR}"
curl -fsSL "${BUNDLE_URL}" | tar -xz -C "${INSTALL_DIR}"

BROWSER_TOKEN="${OPENDIY_REMOTE_TOKEN:-$(openssl rand -hex 24)}"
PC_SECRET="${OPENDIY_REMOTE_HOST_SECRET:-$(openssl rand -hex 24)}"
RUN_USER="$(id -un)"
NODE_BIN="$(command -v node)"

echo "==> [3/4] Registering systemd service (${SERVICE_NAME}.service)..."
sudo tee "/etc/systemd/system/${SERVICE_NAME}.service" > /dev/null <<EOF
[Unit]
Description=OpenDIY Remote 1:1 Relay Server
After=network.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${INSTALL_DIR}
ExecStart=${NODE_BIN} ${INSTALL_DIR}/server/remote-server.mjs \\
  --mode relay \\
  --bind ${BIND_HOST}:${PORT} \\
  --token "${BROWSER_TOKEN}" \\
  --host-secret "${PC_SECRET}"
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

echo "==> [4/4] Starting ${SERVICE_NAME} service..."
sudo systemctl daemon-reload
sudo systemctl enable --now "${SERVICE_NAME}"
sudo systemctl restart "${SERVICE_NAME}"

PUBLIC_IP="$(curl -fsSL --max-time 3 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || hostname -I | awk '{print $1}')"

echo ""
echo "======================================================================"
echo " OpenDIY Remote 1:1 Relay Server (${VERSION}) is active and running!"
echo "======================================================================"
echo "[1] Browser Access Token (--token):"
echo "    ${BROWSER_TOKEN}"
echo ""
echo "[2] Workstation PC Host Secret (--host-secret):"
echo "    ${PC_SECRET}"
echo ""
echo "[3] Connect from your Workstation PC:"
echo "    node server/remote-server.mjs --connect http://${PUBLIC_IP}:${PORT} --host-secret \"${PC_SECRET}\""
echo ""
echo "[4] Open in Web Browser (Desktop / Tablet / Mobile):"
echo "    http://${PUBLIC_IP}:${PORT}/?token=${BROWSER_TOKEN}"
echo "======================================================================"
