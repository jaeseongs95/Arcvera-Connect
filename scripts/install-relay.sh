#!/usr/bin/env bash
set -euo pipefail

# OpenDIY Remote 1:1 Relay — One-Click VPS Installer (Ubuntu / Debian, Full TLS + Google OAuth support)
# Usage:
#   curl -fsSL https://github.com/jaeseongs95/opendiy-remote/releases/download/v1.2.2/install-relay.sh | bash
# Optional Google OAuth flags (via env vars):
#   OPENDIY_REMOTE_GOOGLE_CLIENT_ID="..." \
#   OPENDIY_REMOTE_GOOGLE_CLIENT_SECRET="..." \
#   OPENDIY_REMOTE_ALLOWED_EMAIL="me@gmail.com" \
#   bash <(curl -fsSL https://github.com/jaeseongs95/opendiy-remote/releases/download/v1.2.2/install-relay.sh)

VERSION="${OPENDIY_REMOTE_VERSION:-v1.2.2}"
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

# Preserve existing tokens and Google OAuth settings on upgrade unless explicitly overridden
EXISTING_TOKEN=""
EXISTING_SECRET=""
EXISTING_GOOGLE_ID=""
EXISTING_GOOGLE_SECRET=""
EXISTING_ALLOWED_EMAIL=""
if [ -f "${SERVICE_FILE}" ]; then
  EXISTING_TOKEN="$(sed -n 's/.*--token "\([^"]*\)".*/\1/p' "${SERVICE_FILE}" | head -n 1 || true)"
  EXISTING_SECRET="$(sed -n 's/.*--host-secret "\([^"]*\)".*/\1/p' "${SERVICE_FILE}" | head -n 1 || true)"
  EXISTING_GOOGLE_ID="$(sed -n 's/.*--google-client-id "\([^"]*\)".*/\1/p' "${SERVICE_FILE}" | head -n 1 || true)"
  EXISTING_GOOGLE_SECRET="$(sed -n 's/.*--google-client-secret "\([^"]*\)".*/\1/p' "${SERVICE_FILE}" | head -n 1 || true)"
  EXISTING_ALLOWED_EMAIL="$(sed -n 's/.*--allowed-email "\([^"]*\)".*/\1/p' "${SERVICE_FILE}" | head -n 1 || true)"
fi

BROWSER_TOKEN="${OPENDIY_REMOTE_TOKEN:-${EXISTING_TOKEN:-$(openssl rand -hex 24)}}"
PC_SECRET="${OPENDIY_REMOTE_HOST_SECRET:-${EXISTING_SECRET:-$(openssl rand -hex 24)}}"
GOOGLE_CLIENT_ID="${OPENDIY_REMOTE_GOOGLE_CLIENT_ID:-${EXISTING_GOOGLE_ID}}"
GOOGLE_CLIENT_SECRET="${OPENDIY_REMOTE_GOOGLE_CLIENT_SECRET:-${EXISTING_GOOGLE_SECRET}}"
ALLOWED_EMAIL="${OPENDIY_REMOTE_ALLOWED_EMAIL:-${EXISTING_ALLOWED_EMAIL}}"
RUN_USER="$(id -un)"
NODE_BIN="$(command -v node)"

OAUTH_ARGS=""
if [ -n "${GOOGLE_CLIENT_ID}" ] && [ -n "${GOOGLE_CLIENT_SECRET}" ] && [ -n "${ALLOWED_EMAIL}" ]; then
  OAUTH_ARGS="  --google-client-id \"${GOOGLE_CLIENT_ID}\" \\
  --google-client-secret \"${GOOGLE_CLIENT_SECRET}\" \\
  --allowed-email \"${ALLOWED_EMAIL}\" \\"
fi

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
${OAUTH_ARGS}
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
if [ -n "${GOOGLE_CLIENT_ID}" ] && [ -n "${ALLOWED_EMAIL}" ]; then
  echo "    (Google OAuth Enabled for: ${ALLOWED_EMAIL})"
fi
echo ""
echo "[2] Workstation PC Host Secret (--host-secret):"
echo "    ${PC_SECRET}"
echo "======================================================================"
