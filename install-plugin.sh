#!/bin/bash
# ============================================================
# VPS Sync — Plugin installer (macOS / Linux desktop)
# Installs the latest plugin release into an Obsidian vault.
#
# Usage:
#   bash install-plugin.sh /path/to/your/vault
#
# Example:
#   bash install-plugin.sh ~/Documents/MyVault
# ============================================================
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info() { echo -e "${GREEN}[vps-sync]${NC} $*"; }
die()  { echo -e "${RED}[vps-sync] ERROR:${NC} $*"; exit 1; }

# ── 1. Validate vault path ───────────────────────────────────
VAULT="${1:-}"
if [[ -z "$VAULT" ]]; then
  die "Usage: $0 /path/to/your/vault"
fi

VAULT=$(realpath "$VAULT")
if [[ ! -d "$VAULT" ]]; then
  die "Vault directory not found: $VAULT"
fi

PLUGIN_DIR="$VAULT/.obsidian/plugins/vps-sync"

# ── 2. Fetch latest release assets ───────────────────────────
info "Fetching latest release from GitHub..."
RELEASE_JSON=$(curl -fsSL https://api.github.com/repos/onemacos/obsidian-vps-sync/releases/latest)

MAIN_JS_URL=$(echo "$RELEASE_JSON" | grep '"browser_download_url"' | grep 'main\.js' | cut -d'"' -f4)
MANIFEST_URL=$(echo "$RELEASE_JSON" | grep '"browser_download_url"' | grep 'manifest\.json' | cut -d'"' -f4)
VERSION=$(echo "$RELEASE_JSON" | grep '"tag_name"' | cut -d'"' -f4)

if [[ -z "$MAIN_JS_URL" || -z "$MANIFEST_URL" ]]; then
  die "Could not find release assets. Check your internet connection or visit:
  https://github.com/onemacos/obsidian-vps-sync/releases"
fi

# ── 3. Install ───────────────────────────────────────────────
info "Installing VPS Sync ${VERSION} into:"
info "  $PLUGIN_DIR"

mkdir -p "$PLUGIN_DIR"
curl -fsSL "$MAIN_JS_URL"   -o "$PLUGIN_DIR/main.js"
curl -fsSL "$MANIFEST_URL"  -o "$PLUGIN_DIR/manifest.json"

# ── 4. Done ───────────────────────────────────────────────────
echo ""
info "Done! VPS Sync ${VERSION} installed."
echo ""
echo "  Next steps:"
echo "  1. Restart Obsidian (or reload plugins)"
echo "  2. Settings → Community Plugins → enable 'VPS Sync'"
echo "  3. Settings → VPS Sync → enter your Server URL and API Key"
echo ""
echo "  If Obsidian is already running, you can reload without restarting:"
echo "  Cmd/Ctrl+P → 'Reload app without saving'"
