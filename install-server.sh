#!/bin/bash
# ============================================================
# VPS Sync — Server installer (Ubuntu / Debian)
# Run this on the VPS as root or a user with sudo.
#
# Usage:
#   bash install-server.sh
# ============================================================
set -euo pipefail

INSTALL_DIR=/opt/vps-sync
VAULT_DIR=/opt/vault
BACKUP_DIR=/opt/vault-backups
PORT=3241

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()    { echo -e "${GREEN}[vps-sync]${NC} $*"; }
warn()    { echo -e "${YELLOW}[vps-sync]${NC} $*"; }
die()     { echo -e "${RED}[vps-sync] ERROR:${NC} $*"; exit 1; }

# ── 1. Check OS ──────────────────────────────────────────────
if [[ ! -f /etc/debian_version ]]; then
  die "This script is for Debian/Ubuntu. Adapt manually for other distros."
fi

# ── 2. Install Node.js 20 LTS ────────────────────────────────
if ! command -v node &>/dev/null || [[ "$(node --version | cut -d. -f1 | tr -d 'v')" -lt 18 ]]; then
  info "Installing Node.js 20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs build-essential git
else
  info "Node.js $(node --version) already installed — skipping."
fi

# ── 3. Install PM2 ───────────────────────────────────────────
if ! command -v pm2 &>/dev/null; then
  info "Installing PM2..."
  npm install -g pm2
else
  info "PM2 already installed — skipping."
fi

# ── 4. Create directories ────────────────────────────────────
info "Creating directories..."
mkdir -p "$INSTALL_DIR" "$VAULT_DIR" "$BACKUP_DIR"

# ── 5. Download latest release ───────────────────────────────
info "Fetching latest release info from GitHub..."
LATEST_URL=$(curl -fsSL https://api.github.com/repos/onemacos/obsidian-vps-sync/releases/latest \
  | grep '"tarball_url"' | cut -d'"' -f4)

if [[ -z "$LATEST_URL" ]]; then
  die "Could not fetch release info. Check your internet connection."
fi

info "Downloading server source..."
TMP=$(mktemp -d)
curl -fsSL "$LATEST_URL" -o "$TMP/release.tar.gz"
tar -xzf "$TMP/release.tar.gz" -C "$TMP" --strip-components=1
cp -r "$TMP/server/." "$INSTALL_DIR/"
rm -rf "$TMP"

# ── 6. Install npm dependencies & build ──────────────────────
info "Installing dependencies and building..."
cd "$INSTALL_DIR"
npm install --production=false
npm run build
npm prune --production   # strip dev deps after build

# ── 7. Create .env if not present ────────────────────────────
if [[ ! -f "$INSTALL_DIR/.env" ]]; then
  info "Generating .env..."
  API_KEY=$(openssl rand -hex 32)
  cat > "$INSTALL_DIR/.env" <<EOF
API_KEY=${API_KEY}
PORT=${PORT}
VAULT_PATH=${VAULT_DIR}
BACKUP_PATH=${BACKUP_DIR}
NODE_ENV=production
EOF
  chmod 600 "$INSTALL_DIR/.env"
  warn "Generated API key: ${YELLOW}${API_KEY}${NC}"
  warn "Save this key — you'll need it in the Obsidian plugin settings."
else
  info ".env already exists — keeping existing configuration."
fi

# ── 8. PM2 start / restart ───────────────────────────────────
info "Starting server with PM2..."
cd "$INSTALL_DIR"
if pm2 list | grep -q vps-sync; then
  pm2 restart vps-sync
else
  pm2 start ecosystem.config.js
fi
pm2 save

# ── 9. PM2 startup (systemd) ─────────────────────────────────
info "Configuring PM2 to start on boot..."
pm2 startup systemd -u root --hp /root 2>/dev/null || true
pm2 save

# ── 10. Firewall ──────────────────────────────────────────────
if command -v ufw &>/dev/null; then
  if ufw status | grep -q "Status: active"; then
    info "Opening port ${PORT}/tcp in UFW..."
    ufw allow "${PORT}/tcp" comment "VPS Sync"
  fi
fi

# ── Done ──────────────────────────────────────────────────────
echo ""
info "Installation complete!"
echo ""
echo "  Vault:     ${VAULT_DIR}"
echo "  Backups:   ${BACKUP_DIR}"
echo "  Port:      ${PORT}"
echo ""
echo "  Health:    curl -H 'x-api-key: \$(grep API_KEY ${INSTALL_DIR}/.env | cut -d= -f2)' http://localhost:${PORT}/health"
echo "  Logs:      pm2 logs vps-sync"
echo ""
echo "  Next step: configure the Obsidian plugin with:"
echo "    Server URL: ws://$(hostname -I | awk '{print $1}'):${PORT}"
if [[ -f "$INSTALL_DIR/.env" ]]; then
  echo "    API Key:    $(grep API_KEY "$INSTALL_DIR/.env" | cut -d= -f2)"
fi
