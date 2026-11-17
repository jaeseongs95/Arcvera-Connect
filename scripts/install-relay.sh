#!/usr/bin/env bash
set -euo pipefail

# Arcvera Connect (OpenDIY Remote) 1:1 Relay — One-Click VPS Installer (Ubuntu / Debian, Full TLS + Google OAuth support)
# Usage:
#   curl -fsSL https://github.com/jaeseongs95/Arcvera-Connect/releases/download/v1.2.3/install-relay.sh | bash
# Optional Google OAuth flags (via env vars):
#   OPENDIY_REMOTE_GOOGLE_CLIENT_ID="..." \
#   OPENDIY_REMOTE_GOOGLE_CLIENT_SECRET="..." \
#   OPENDIY_REMOTE_ALLOWED_EMAIL="me@gmail.com" \
#   bash <(curl -fsSL https://github.com/jaeseongs95/Arcvera-Connect/releases/download/v1.2.3/install-relay.sh)

VERSION="${OPENDIY_REMOTE_VERSION:-v1.2.3}"
PORT="${OPENDIY_REMOTE_PORT:-3210}"
BIND_HOST="${OPENDIY_REMOTE_BIND_HOST:-0.0.0.0}"
INSTALL_DIR="${OPENDIY_REMOTE_DIR:-$HOME/opendiy-remote}"
SERVICE_NAME="opendiy-remote"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
REPO_SLUG="${OPENDIY_REMOTE_REPO:-jaeseongs95/Arcvera-Connect}"
RELEASE_API_URL="${OPENDIY_REMOTE_RELEASE_API_URL:-https://api.github.com/repos/${REPO_SLUG}/releases/tags/${VERSION}}"
PRIMARY_BUNDLE_NAME="arcvera-connect-${VERSION}-relay-bundle.tar.gz"
FALLBACK_BUNDLE_NAME="opendiy-remote-${VERSION}-relay-bundle.tar.gz"

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
  echo "    Installing Node.js 22 LTS via signed APT keyring..."
  sudo apt-get update -y
  sudo apt-get install -y ca-certificates curl gnupg
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | sudo gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  sudo chmod a+r /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    | sudo tee /etc/apt/sources.list.d/nodesource.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y nodejs
  echo "    Installed Node.js $(node -v)"
fi

echo "==> [2/5] Downloading & SHA-256 verifying Arcvera Connect (${VERSION}) to ${INSTALL_DIR}..."
mkdir -p "${INSTALL_DIR}"
STAGE_DIR="$(mktemp -d "${INSTALL_DIR}/.install-stage.XXXXXX")"
cleanup_stage() {
  rm -rf "${STAGE_DIR}"
}
trap cleanup_stage EXIT

validate_github_https_url() {
  local target_url="$1"
  local label="$2"
  TARGET_URL="${target_url}" URL_LABEL="${label}" node -e '
    const raw = String(process.env.TARGET_URL || "").trim();
    const label = String(process.env.URL_LABEL || "URL");
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      console.error("Error: Invalid " + label + ": " + raw);
      process.exit(1);
    }
    const allowedHosts = new Set([
      "github.com",
      "api.github.com",
      "objects.githubusercontent.com",
      "release-assets.githubusercontent.com",
      "codeload.github.com",
    ]);
    const host = parsed.hostname.toLowerCase();
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      (parsed.port !== "" && parsed.port !== "443") ||
      !allowedHosts.has(host)
    ) {
      console.error("Error: Untrusted " + label + " (must be https:// on an official GitHub release host): " + raw);
      process.exit(1);
    }
  '
}

shell_quote_single() {
  printf '%s' "$1" | node -e '
    const fs = require("node:fs");
    const sq = String.fromCharCode(39);
    const bs = String.fromCharCode(92);
    const val = fs.readFileSync(0, "utf8");
    process.stdout.write(sq + val.split(sq).join(sq + bs + sq + sq) + sq);
  '
}

BUNDLE_URL="${OPENDIY_REMOTE_BUNDLE_URL:-}"
EXPECTED_SHA256="${OPENDIY_REMOTE_BUNDLE_SHA256:-}"

if [ -n "${BUNDLE_URL}" ]; then
  validate_github_https_url "${BUNDLE_URL}" "OPENDIY_REMOTE_BUNDLE_URL"
  if [[ ! "${EXPECTED_SHA256}" =~ ^[a-fA-F0-9]{64}$ ]]; then
    echo "Error: OPENDIY_REMOTE_BUNDLE_SHA256 (64-char hex) is required when OPENDIY_REMOTE_BUNDLE_URL is set." >&2
    exit 1
  fi
  EXPECTED_SHA256="$(printf '%s' "${EXPECTED_SHA256}" | tr '[:upper:]' '[:lower:]')"
else
  validate_github_https_url "${RELEASE_API_URL}" "OPENDIY_REMOTE_RELEASE_API_URL"
  RELEASE_JSON="${STAGE_DIR}/release.json"
  curl -fsSL --retry 3 -H "Accept: application/vnd.github+json" -o "${RELEASE_JSON}" "${RELEASE_API_URL}"
  RESOLVED_ASSET="$(REL_JSON="${RELEASE_JSON}" REL_VER="${VERSION}" PRI_NAME="${PRIMARY_BUNDLE_NAME}" FB_NAME="${FALLBACK_BUNDLE_NAME}" node -e '
    const fs = require("node:fs");
    const rel = JSON.parse(fs.readFileSync(process.env.REL_JSON, "utf8"));
    const ver = process.env.REL_VER || "";
    const assets = Array.isArray(rel.assets) ? rel.assets : [];
    const candidates = [process.env.PRI_NAME, process.env.FB_NAME].filter(Boolean);
    let asset = null;
    for (const name of candidates) {
      asset = assets.find(a => a && a.name === name);
      if (asset) break;
    }
    if (!asset) {
      asset = assets.find(a => a && typeof a.name === "string" && a.name.endsWith("-relay-bundle.tar.gz"));
    }
    if (!asset || !asset.browser_download_url) {
      console.error("Error: No relay bundle asset found in release " + ver + ".");
      process.exit(1);
    }
    const rawDigest = String(asset.digest || "").trim();
    const hex = rawDigest.toLowerCase().startsWith("sha256:")
      ? rawDigest.slice(7).toLowerCase()
      : rawDigest.toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hex)) {
      console.error("Error: Release asset " + asset.name + " is missing a valid SHA-256 digest.");
      process.exit(1);
    }
    process.stdout.write(asset.browser_download_url + String.fromCharCode(9) + hex);
  ')"
  BUNDLE_URL="${RESOLVED_ASSET%%$'\t'*}"
  EXPECTED_SHA256="${RESOLVED_ASSET#*$'\t'}"
  validate_github_https_url "${BUNDLE_URL}" "release bundle download URL"
fi

BUNDLE_ARCHIVE="${STAGE_DIR}/bundle.tar.gz"
EXTRACT_DIR="${STAGE_DIR}/extracted"
mkdir -p "${EXTRACT_DIR}"
curl -fsSL --retry 3 -o "${BUNDLE_ARCHIVE}" "${BUNDLE_URL}"

ACTUAL_SHA256="$(sha256sum "${BUNDLE_ARCHIVE}" | awk '{print tolower($1)}')"
if [ -z "${EXPECTED_SHA256}" ] || [ "${ACTUAL_SHA256}" != "${EXPECTED_SHA256}" ]; then
  echo "Error: Bundle SHA-256 verification failed (expected ${EXPECTED_SHA256:-<empty>}, got ${ACTUAL_SHA256})." >&2
  exit 1
fi
echo "    Verified bundle SHA-256: ${ACTUAL_SHA256}"

tar -xzf "${BUNDLE_ARCHIVE}" -C "${EXTRACT_DIR}"
if [ ! -f "${EXTRACT_DIR}/package.json" ] || [ ! -f "${EXTRACT_DIR}/server/remote-server.mjs" ] || [ ! -f "${EXTRACT_DIR}/dist/index.html" ]; then
  echo "Error: Extracted bundle is missing required files (package.json, server/remote-server.mjs, dist/index.html)." >&2
  exit 1
fi

BACKUP_STAGE="${INSTALL_DIR}/.backup-stage.$$"
rm -rf "${BACKUP_STAGE}"
mkdir -p "${BACKUP_STAGE}"
SWAPPED_TARGETS=()
HAD_PREV_FLAGS=()
SWAP_FAILED=0

set +e
for target in dist server scripts package.json README.md README.ko.md; do
  if [ -e "${EXTRACT_DIR}/${target}" ]; then
    had_prev=0
    if [ -e "${INSTALL_DIR}/${target}" ]; then
      had_prev=1
      if ! mv "${INSTALL_DIR}/${target}" "${BACKUP_STAGE}/${target}"; then
        SWAP_FAILED=1
        break
      fi
    fi
    SWAPPED_TARGETS+=("${target}")
    HAD_PREV_FLAGS+=("${had_prev}")
    if ! mv "${EXTRACT_DIR}/${target}" "${INSTALL_DIR}/${target}"; then
      SWAP_FAILED=1
      break
    fi
  fi
done

if [ "${SWAP_FAILED}" -ne 0 ]; then
  echo "Error: Atomic bundle swap failed mid-flight; rolling back previous installation..." >&2
  ROLLBACK_CLEAN=1
  idx=$(( ${#SWAPPED_TARGETS[@]} - 1 ))
  while [ "${idx}" -ge 0 ]; do
    t="${SWAPPED_TARGETS[$idx]}"
    prev_flag="${HAD_PREV_FLAGS[$idx]}"
    rm -rf "${INSTALL_DIR:?}/${t}" || ROLLBACK_CLEAN=0
    if [ "${prev_flag}" -eq 1 ] && [ -e "${BACKUP_STAGE}/${t}" ]; then
      mv "${BACKUP_STAGE}/${t}" "${INSTALL_DIR}/${t}" || ROLLBACK_CLEAN=0
    fi
    idx=$(( idx - 1 ))
  done
  if [ "${ROLLBACK_CLEAN}" -eq 1 ]; then
    rm -rf "${BACKUP_STAGE}"
  else
    echo "Warning: Partial rollback error; backup preserved at ${BACKUP_STAGE}" >&2
  fi
  set -e
  exit 1
fi
rm -rf "${INSTALL_DIR}/.backup-prev"
mv "${BACKUP_STAGE}" "${INSTALL_DIR}/.backup-prev" || true
set -e

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
ENV_FILE="${INSTALL_DIR}/.relay.env"
EXISTING_TOKEN=""
EXISTING_SECRET=""
EXISTING_GOOGLE_ID=""
EXISTING_GOOGLE_SECRET=""
EXISTING_ALLOWED_EMAIL=""

read_env_var() {
  local key="$1"
  local file="$2"
  ENV_KEY="$key" ENV_TARGET="$file" node -e '
    const fs = require("node:fs");
    const bs = String.fromCharCode(92);
    const dq = String.fromCharCode(34);
    const lf = String.fromCharCode(10);
    const cr = String.fromCharCode(13);
    const tab = String.fromCharCode(9);
    const key = process.env.ENV_KEY || "";
    const file = process.env.ENV_TARGET || "";
    if (!fs.existsSync(file)) process.exit(0);
    const lines = fs.readFileSync(file, "utf8").split(cr).join("").split(lf);
    for (const line of lines) {
      if (!line.startsWith(key + "=")) continue;
      let raw = line.slice(key.length + 1);
      if (raw.length >= 2 && raw.startsWith(dq) && raw.endsWith(dq)) {
        raw = raw.slice(1, -1);
        let out = "";
        for (let i = 0; i < raw.length; i += 1) {
          if (raw[i] === bs && i + 1 < raw.length) {
            const next = raw[i + 1];
            i += 1;
            out += next === "n" ? lf : next === "r" ? cr : next === "t" ? tab : next;
          } else {
            out += raw[i];
          }
        }
        raw = out;
      }
      process.stdout.write(raw);
      break;
    }
  ' 2>/dev/null || true
}

escape_env_val() {
  printf '%s' "$1" | node -e '
    const fs = require("node:fs");
    const bs = String.fromCharCode(92);
    const dq = String.fromCharCode(34);
    const lf = String.fromCharCode(10);
    const cr = String.fromCharCode(13);
    const val = fs.readFileSync(0, "utf8").split(cr).join("").split(lf).join("");
    process.stdout.write(val.split(bs).join(bs + bs).split(dq).join(bs + dq));
  '
}

if [ -r "${ENV_FILE}" ]; then
  EXISTING_TOKEN="$(read_env_var "OPENDIY_REMOTE_TOKEN" "${ENV_FILE}")"
  EXISTING_SECRET="$(read_env_var "OPENDIY_REMOTE_HOST_SECRET" "${ENV_FILE}")"
  EXISTING_GOOGLE_ID="$(read_env_var "OPENDIY_REMOTE_GOOGLE_CLIENT_ID" "${ENV_FILE}")"
  EXISTING_GOOGLE_SECRET="$(read_env_var "OPENDIY_REMOTE_GOOGLE_CLIENT_SECRET" "${ENV_FILE}")"
  EXISTING_ALLOWED_EMAIL="$(read_env_var "OPENDIY_REMOTE_ALLOWED_EMAIL" "${ENV_FILE}")"
fi

if [ -f "${SERVICE_FILE}" ]; then
  [ -z "${EXISTING_TOKEN}" ] && EXISTING_TOKEN="$(sed -n 's/.*--token "\([^"]*\)".*/\1/p' "${SERVICE_FILE}" 2>/dev/null | head -n 1 || true)"
  [ -z "${EXISTING_SECRET}" ] && EXISTING_SECRET="$(sed -n 's/.*--host-secret "\([^"]*\)".*/\1/p' "${SERVICE_FILE}" 2>/dev/null | head -n 1 || true)"
  [ -z "${EXISTING_GOOGLE_ID}" ] && EXISTING_GOOGLE_ID="$(sed -n 's/.*--google-client-id "\([^"]*\)".*/\1/p' "${SERVICE_FILE}" 2>/dev/null | head -n 1 || true)"
  [ -z "${EXISTING_GOOGLE_SECRET}" ] && EXISTING_GOOGLE_SECRET="$(sed -n 's/.*--google-client-secret "\([^"]*\)".*/\1/p' "${SERVICE_FILE}" 2>/dev/null | head -n 1 || true)"
  [ -z "${EXISTING_ALLOWED_EMAIL}" ] && EXISTING_ALLOWED_EMAIL="$(sed -n 's/.*--allowed-email "\([^"]*\)".*/\1/p' "${SERVICE_FILE}" 2>/dev/null | head -n 1 || true)"
fi

BROWSER_TOKEN="${OPENDIY_REMOTE_TOKEN:-${EXISTING_TOKEN:-$(openssl rand -hex 24)}}"
PC_SECRET="${OPENDIY_REMOTE_HOST_SECRET:-${EXISTING_SECRET:-$(openssl rand -hex 24)}}"
GOOGLE_CLIENT_ID="${OPENDIY_REMOTE_GOOGLE_CLIENT_ID:-${EXISTING_GOOGLE_ID}}"
GOOGLE_CLIENT_SECRET="${OPENDIY_REMOTE_GOOGLE_CLIENT_SECRET:-${EXISTING_GOOGLE_SECRET}}"
ALLOWED_EMAIL="${OPENDIY_REMOTE_ALLOWED_EMAIL:-${EXISTING_ALLOWED_EMAIL}}"
RUN_USER="$(id -un)"
NODE_BIN="$(command -v node)"

(
  umask 077
  {
    printf 'OPENDIY_REMOTE_TOKEN="%s"\n' "$(escape_env_val "${BROWSER_TOKEN}")"
    printf 'OPENDIY_REMOTE_HOST_SECRET="%s"\n' "$(escape_env_val "${PC_SECRET}")"
    if [ -n "${GOOGLE_CLIENT_ID}" ] && [ -n "${GOOGLE_CLIENT_SECRET}" ] && [ -n "${ALLOWED_EMAIL}" ]; then
      printf 'OPENDIY_REMOTE_GOOGLE_CLIENT_ID="%s"\n' "$(escape_env_val "${GOOGLE_CLIENT_ID}")"
      printf 'OPENDIY_REMOTE_GOOGLE_CLIENT_SECRET="%s"\n' "$(escape_env_val "${GOOGLE_CLIENT_SECRET}")"
      printf 'OPENDIY_REMOTE_ALLOWED_EMAIL="%s"\n' "$(escape_env_val "${ALLOWED_EMAIL}")"
    fi
  } > "${ENV_FILE}"
)
chmod 600 "${ENV_FILE}"

echo "==> [4/5] Registering systemd service (${SERVICE_NAME}.service with Full TLS)..."
sudo tee "${SERVICE_FILE}" > /dev/null <<EOF
[Unit]
Description=OpenDIY Remote 1:1 Relay Server (HTTPS/TLS)
After=network.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart="${NODE_BIN}" "${INSTALL_DIR}/server/remote-server.mjs" \\
  --mode relay \\
  --bind "${BIND_HOST}:${PORT}" \\
  --tls-cert "${TLS_CERT}" \\
  --tls-key "${TLS_KEY}"
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
TLS_FINGERPRINT="$(openssl x509 -in "${TLS_CERT}" -noout -fingerprint -sha256 2>/dev/null | sed 's/^.*=//' || true)"

echo ""
echo "======================================================================"
echo " Arcvera Connect 1:1 Relay (${VERSION}) is running with HTTPS (TLS)!"
echo "======================================================================"
if [ -n "${PUBLIC_IP}" ]; then
  echo "[0] Relay Web Login URL:"
  echo "    https://${PUBLIC_IP}:${PORT}/"
  echo "    (Enter the Browser Access Token below on the sign-in form)"
  echo ""
fi
echo "[1] Browser Access Token (--token):"
echo "    ${BROWSER_TOKEN}"
if [ -n "${GOOGLE_CLIENT_ID}" ] && [ -n "${ALLOWED_EMAIL}" ]; then
  echo "    (Google OAuth Enabled for: ${ALLOWED_EMAIL})"
fi
echo ""
if [ -n "${TLS_FINGERPRINT}" ]; then
  echo "[2] Relay TLS Certificate SHA-256 Fingerprint:"
  echo "    ${TLS_FINGERPRINT}"
  if [ -n "${PUBLIC_IP}" ]; then
    echo "    Copy cert to workstation: scp ${RUN_USER}@${PUBLIC_IP}:${TLS_CERT} ./relay-cert.pem"
  fi
  echo ""
fi
echo "[3] Workstation PC Host Secret (--host-secret):"
echo "    ${PC_SECRET}"
if [ -n "${PUBLIC_IP}" ]; then
  QUOTED_PC_SECRET="$(shell_quote_single "${PC_SECRET}")"
  echo "    Connect command: node server/remote-server.mjs --connect https://${PUBLIC_IP}:${PORT} --host-secret ${QUOTED_PC_SECRET} --tls-ca ./relay-cert.pem"
fi
echo "======================================================================"
