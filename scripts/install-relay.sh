#!/usr/bin/env bash
set -euo pipefail

# OpenDIY Remote 1:1 Relay — One-Click VPS Installer (Ubuntu / Debian, Full TLS by default)
# Usage:
#   curl -fsSL https://github.com/jaeseongs95/opendiy-remote/releases/download/v1.0.0/install-relay.sh | bash

VERSION="${OPENDIY_REMOTE_VERSION:-v1.0.0}"
PORT="${OPENDIY_REMOTE_PORT:-3210}"
BIND_HOST="${OPENDIY_REMOTE_BIND_HOST:-0.0.0.0}"
INSTALL_DIR="${OPENDIY_REMOTE_DIR:-$HOME/opendiy-remote}"
SERVICE_NAME="opendiy-remote"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
BUNDLE_URL="https://github.com/jaeseongs95/opendiy-remote/releases/download/${VERSION}/opendiy-remote-${VERSION}-relay-bundle.tar.gz"

echo "==> [1/5] Checking Node.js (>= 22)..."
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

echo "==> [2/5] Downloading & extracting OpenDIY Remote (${VERSION}) to ${INSTALL_DIR}..."
mkdir -p "${INSTALL_DIR}"
curl -fsSL "${BUNDLE_URL}" | tar -xz -C "${INSTALL_DIR}"

TLS_DIR="${INSTALL_DIR}/tls"
TLS_CERT="${OPENDIY_REMOTE_TLS_CERT:-${TLS_DIR}/cert.pem}"
TLS_KEY="${OPENDIY_REMOTE_TLS_KEY:-${TLS_DIR}/key.pem}"

echo "==> [3/5] Ensuring Origin TLS Certificate (${TLS_CERT})..."
mkdir -p "${TLS_DIR}"
if [ ! -s "${TLS_CERT}" ] || [ ! -s "${TLS_KEY}" ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
    -nodes -keyout "${TLS_KEY}" -out "${TLS_CERT}" \
    -days 3650 -subj "/CN=opendiy-remote" >/dev/null 2>&1
  chmod 600 "${TLS_KEY}"
  chmod 644 "${TLS_CERT}"
  echo "    Generated 10-year ECDSA P-256 TLS certificate for end-to-end encryption."
else
  echo "    Reusing existing TLS certificate."
fi

# Preserve existing tokens on upgrade unless explicitly overridden
EXISTING_TOKEN=""
EXISTING_SECRET=""
if [ -f "${SERVICE_FILE}" ]; then
  EXISTING_TOKEN="$(sed -n 's/.*--token "\([^"]*\)".*/\1/p' "${SERVICE_FILE}" | head -n 1 || true)"
  EXISTING_SECRET="$(sed -n 's/.*--host-secret "\([^"]*\)".*/\1/p' "${SERVICE_FILE}" | head -n 1 || true)"
fi

BROWSER_TOKEN="${OPENDIY_REMOTE_TOKEN:-${EXISTING_TOKEN:-$(openssl rand -hex 24)}}"
PC_SECRET="${OPENDIY_REMOTE_HOST_SECRET:-${EXISTING_SECRET:-$(openssl rand -hex 24)}}"
RUN_USER="$(id -un)"
NODE_BIN="$(command -v node)"

echo "==> [4/5] Registering systemd service (${SERVICE_NAME}.service with Full TLS)..."
sudo tee "${SERVICE_FILE}" > /dev/null <<EOF
[Unit]
Description=OpenDIY Remote 1:1 Relay Server (HTTPS/TLS)
After=network.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${INSTALL_DIR}
ExecStart=${NODE_BIN} ${INSTALL_DIR}/server/remote-server.mjs \\
  --mode relay \\
  --bind ${BIND_HOST}:${PORT} \\
  --tls-cert "${TLS_CERT}" \\
  --tls-key "${TLS_KEY}" \\
  --token "${BROWSER_TOKEN}" \\
  --host-secret "${PC_SECRET}"
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

echo "==> [5/5] Starting ${SERVICE_NAME} service..."
sudo systemctl daemon-reload
sudo systemctl enable --now "${SERVICE_NAME}"
sudo systemctl restart "${SERVICE_NAME}"

PUBLIC_IP="$(curl -fsSL --max-time 3 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || hostname -I | awk '{print $1}')"

echo ""
echo "======================================================================"
echo " OpenDIY Remote 1:1 Relay (${VERSION}) is running with HTTPS (TLS)!"
echo "======================================================================"
echo "[1] Browser Access Token (--token):"
echo "    ${BROWSER_TOKEN}"
echo ""
echo "[2] Workstation PC Host Secret (--host-secret):"
echo "    ${PC_SECRET}"
echo ""
echo "[3] Connect from your Workstation PC (via Cloudflare Full TLS domain):"
echo "    node server/remote-server.mjs --connect https://<your-domain> --host-secret \"${PC_SECRET}\""
echo "    (or direct IP with self-signed TLS: --connect https://${PUBLIC_IP}:${PORT} --tls-insecure --host-secret \"${PC_SECRET}\")"
echo ""
echo "[4] Open in Web Browser (Desktop / Tablet / Mobile):"
echo "    https://<your-domain>/?token=${BROWSER_TOKEN}"
echo "======================================================================"
