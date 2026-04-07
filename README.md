# Obsidian VPS Sync

> Real-time vault sync across all your devices — on your own server, with no subscription.

[![Version](https://img.shields.io/badge/version-1.0.1-blue)](https://github.com/onemacos/obsidian-vps-sync/releases/latest)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.4%2B-purple)](https://obsidian.md)
[![Platform](https://img.shields.io/badge/platform-desktop%20%7C%20Android%20%7C%20iOS-green)](#)
[![License](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

---

## What It Does

VPS Sync keeps your Obsidian vault in sync across every device — desktop, Android, iOS — via a lightweight WebSocket server you run on your own VPS. Changes propagate in real time: save a note on your phone and it appears on your laptop within seconds.

| Feature | Details |
|---------|---------|
| **Real-time sync** | File changes pushed instantly over persistent WebSocket |
| **All platforms** | Desktop (Windows/macOS/Linux), Android, iOS |
| **All file types** | `.md`, `.canvas`, `.excalidraw`, `.mdenc`, images, PDFs, and more |
| **Conflict handling** | Keeps both versions — `Note (conflict 2026-03-12T14-32-00).md` |
| **Rename/move detection** | Moves and renames sync correctly without creating duplicates |
| **Encrypted files** | Full support for Meld Encrypt (`.mdenc`) files |
| **Silent background sync** | No popups during automatic sync — notices only on manual Force Sync |
| **Self-hosted** | Your data stays on your server, no third-party storage |

---

## Architecture

```
┌──────────────────────┐   wss://     ┌────────────────────────┐
│  Obsidian Plugin     │ ◄──────────► │  Node.js VPS Server    │
│  TypeScript          │              │  Express + ws          │
│  All platforms       │              │  Port 3241             │
└──────────────────────┘              └────────────────────────┘
                                             │
                                       /opt/vault/
                                    (your files, on your VPS)
```

- **Transport:** Persistent WebSocket (`wss://` with TLS)
- **Protocol:** Custom JSON message protocol — no REST, no polling
- **Auth:** Static API key (set in server `.env`, masked in plugin settings)
- **Encoding:** UTF-8 for text files, Base64 for binary

---

## Installation

### Server — one-line install (Ubuntu / Debian)

Run this on your VPS as root:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/onemacos/obsidian-vps-sync/master/install-server.sh)
```

This installs Node.js, PM2, downloads the latest release, generates an API key, starts the server, and configures boot autostart.

### Plugin — one-line install (macOS / Linux)

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/onemacos/obsidian-vps-sync/master/install-plugin.sh) /path/to/your/vault
```

Then in Obsidian: **Settings → Community Plugins → enable VPS Sync → enter your Server URL and API Key**.

> See [`SETUP.md`](SETUP.md) for the full step-by-step guide, Nginx + TLS setup, and troubleshooting.

### Plugin — BRAT (automatic updates)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Obsidian Community Plugins
2. BRAT settings → **Add Beta Plugin** → `onemacos/obsidian-vps-sync`
3. Enable **VPS Sync** in Community Plugins

### Plugin — Manual

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/onemacos/obsidian-vps-sync/releases/latest)
2. Create folder: `<your-vault>/.obsidian/plugins/vps-sync/`
3. Copy both files into that folder
4. Enable **VPS Sync** in Obsidian → Settings → Community Plugins

---

## Server Setup (manual)

### Requirements

- A VPS running Ubuntu 20.04+ (or any Linux with Node.js 20+)
- A domain name with DNS pointed at your VPS (recommended for TLS)
- Ports: `3241` open, or `443` if using Nginx as a reverse proxy

### Step 1 — Install Node.js and PM2

```bash
# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs build-essential git

# PM2 (process manager — keeps server running after reboot)
sudo npm install -g pm2
```

### Step 2 — Deploy the server

```bash
# Clone the repo on your VPS
git clone https://github.com/onemacos/obsidian-vps-sync.git /opt/vps-sync

cd /opt/vps-sync/server
npm install
npm run build
```

### Step 3 — Configure environment

```bash
cp .env.example .env
nano .env
```

```env
API_KEY=<generate with: openssl rand -hex 32>
PORT=3241
VAULT_PATH=/opt/vault
NODE_ENV=production
```

```bash
# Lock down the env file
chmod 600 .env

# Create vault storage directory
sudo mkdir -p /opt/vault
```

> **Generate a strong API key:**
> ```bash
> openssl rand -hex 32
> ```

### Step 4 — Start with PM2

```bash
cd /opt/vps-sync/server
pm2 start ecosystem.config.js
pm2 startup systemd    # enable autostart on boot
pm2 save               # persist the process list
pm2 status             # verify it's running
```

### Step 5 — Open firewall

```bash
sudo ufw allow 3241/tcp
sudo ufw enable
```

### Step 6 — (Recommended) Nginx + TLS

Using Nginx as a reverse proxy gives you `wss://yourdomain.com` on port 443 with automatic HTTPS via Let's Encrypt.

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

Create `/etc/nginx/sites-available/vps-sync`:

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass         http://localhost:3241;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "Upgrade";
        proxy_set_header   Host       $host;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/vps-sync /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d yourdomain.com
```

Your plugin URL becomes: `wss://yourdomain.com`

---

## Plugin Configuration

Open Obsidian → Settings → **VPS Sync**:

| Setting | Description | Example |
|---------|-------------|---------|
| **Server URL** | WebSocket address of your server | `wss://yourdomain.com` or `wss://1.2.3.4:3241` |
| **API Key** | Secret key from your server `.env` | `a3f8c2...` (masked) |
| **Enable sync** | Toggle sync on/off | On |
| **Exclude patterns** | Glob patterns for files to skip | `.obsidian/**`, `*.tmp` |

### Actions

| Button | What it does |
|--------|-------------|
| **Test Connection** | Connects and authenticates — confirms URL + key are correct |
| **Sync Now** | Runs a full reconciliation against the server right now |
| **Reset** | Restores all settings to defaults |

### Ribbon & Status Bar

- **Refresh icon** in the left ribbon — triggers Force Sync
- **Status bar** (bottom right) — shows current sync state: `connected`, `syncing`, `disconnected`, `error`

---

## How It Works

### Real-time sync

Every file save is debounced (1 second) then pushed to the server as a `FILE_UPSERT` message. The server writes the file, updates its manifest, and broadcasts the change to all other connected devices.

```
Device A saves note.md
  → Plugin debounces 1s
  → Sends FILE_UPSERT { path, content, hash, mtime }
  → Server writes file, sends FILE_ACK
  → Server broadcasts FILE_UPSERT to Device B, C, D
  → Each device writes the file locally
```

### Startup reconciliation

When a device connects (or reconnects), it runs a full reconciliation:

1. Fetches the server's file manifest (all paths + hashes + timestamps)
2. Scans local files
3. Detects renames/moves (compares content hashes to identify moved files)
4. For each file, classifies as: `push`, `pull`, `conflict`, `delete`, or `noop`
5. Processes up to 5 files concurrently

### Rename/move detection

Renames are detected by content hash matching, not path:

- **Case A** — You moved a file offline, server is behind: plugin sends `FILE_RENAME` to server
- **Case B** — Another device moved a file, your device hasn't caught up: plugin renames locally

This prevents the most common sync bug: moving `note.md` into `folder/note.md` creating a duplicate at both paths.

### Conflict handling

If two devices edit the same file simultaneously (both modify it before syncing), the server creates a conflict copy of the incoming version:

```
note.md                          ← server's version (kept)
note (conflict 2026-03-12T14-32-00).md   ← incoming version (saved as copy)
```

Both files are synced to all devices. You review and merge manually — the same behaviour as Obsidian Sync.

### Server ID guard

Every server instance has a UUID that persists between restarts. If the UUID changes (server rebuilt, data wiped), the plugin detects this, clears its local manifest, and does a clean full sync — preventing stale manifest data from causing false deletes.

---

## Supported File Types

| Category | Extensions |
|----------|-----------|
| Notes | `.md`, `.txt`, `.mdx`, `.org`, `.wiki` |
| Obsidian | `.canvas`, `.excalidraw` |
| Encrypted | `.mdenc`, `.enc` |
| Data | `.json`, `.yaml`, `.yml`, `.csv`, `.toml`, `.ini` |
| Code | `.js`, `.ts`, `.py`, `.html`, `.css`, and more |
| Binary | Images, PDFs, audio, fonts, and all other types (base64 encoded) |

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| "Auth failed" | Wrong API key | Check key in plugin settings matches `.env` |
| Status bar: `disconnected` | Server not running or port blocked | `pm2 status` on VPS; check firewall |
| "WebSocket not connected" on Android | App was in background, WS timed out | Tap the ribbon **Sync** icon — it will reconnect automatically |
| Duplicate files after moving | Stale manifest from old bug | Tap **Sync Now** to reconcile — fixed in v1.0.1+ |
| Files not syncing | Path matches exclude pattern | Check Settings → Exclude patterns |
| Conflict copies accumulating | Simultaneous edits on two devices | Normal behaviour — review and delete unwanted copies |
| Plugin not loading | Files in wrong folder | Verify `main.js` + `manifest.json` are in `.obsidian/plugins/vps-sync/` |

### Check server logs

```bash
pm2 logs vps-sync --lines 50
```

### Test the connection manually

```bash
# Install wscat
npm install -g wscat

# Connect to your server
wscat -c wss://yourdomain.com

# Send auth message
{"type":"AUTH","payload":{"apiKey":"your-api-key"}}
# Should receive: {"type":"AUTH_OK","payload":{}}
```

---

## Development

### Plugin

```bash
cd plugin
npm install
npm run dev     # watch mode — rebuilds main.js on every change
```

Install the [Hot Reload](https://github.com/pjeby/hot-reload) community plugin in Obsidian to auto-reload the plugin when `main.js` changes.

### Server

```bash
cd server
npm install
npm run dev     # ts-node-dev with hot reload
```

Server listens on `localhost:3241`. Set plugin URL to `ws://localhost:3241` for local testing.

### Project structure

```
obsidian-vps-sync/
├── plugin/
│   ├── src/
│   │   ├── main.ts            # Plugin entry point, ribbon button
│   │   ├── sync-manager.ts    # Core sync logic, rename detection, reconciliation
│   │   ├── ws-client.ts       # WebSocket client with reconnect + request/response
│   │   ├── manifest-manager.ts # Local manifest (hash + mtime tracking)
│   │   ├── conflict-resolver.ts # Classify: push/pull/conflict/delete/noop
│   │   ├── file-encoder.ts    # text ↔ UTF-8 / binary ↔ base64
│   │   ├── settings.ts        # Settings UI
│   │   ├── status-bar.ts      # Status bar indicator
│   │   └── types.ts           # Shared TypeScript types
│   ├── manifest.json
│   └── esbuild.config.mjs
│
├── server/
│   ├── src/
│   │   ├── index.ts           # Express + WebSocket server entry
│   │   ├── ws-handler.ts      # Message routing, broadcast, ping/pong
│   │   ├── file-manager.ts    # File read/write/rename/delete on disk
│   │   ├── manifest-manager.ts # Server-side manifest (in-memory + persisted)
│   │   ├── conflict-handler.ts # Create conflict copies
│   │   ├── auth.ts            # API key validation
│   │   └── types.ts           # Shared TypeScript types
│   ├── .env.example
│   └── ecosystem.config.js    # PM2 config
│
├── manifest.json              # Root manifest (required for BRAT)
├── install-server.sh          # One-line VPS server installer (Ubuntu/Debian)
├── install-plugin.sh          # One-line plugin installer (macOS/Linux)
├── deploy-server.sh           # Developer deploy script (local → VPS via rsync)
└── SETUP.md                   # Full step-by-step setup guide
```

---

## WebSocket Protocol Reference

All messages are JSON with this shape:

```json
{
  "type": "MESSAGE_TYPE",
  "requestId": "uuid-string",
  "payload": { }
}
```

### Client → Server

| Type | Purpose | Key payload fields |
|------|---------|-------------------|
| `AUTH` | Authenticate | `apiKey` |
| `MANIFEST_REQUEST` | Fetch all server file records | — |
| `FILE_UPSERT` | Push a file | `path`, `content`, `encoding`, `hash`, `mtime`, `serverMtime` |
| `FILE_DELETE` | Delete a file | `path` |
| `FILE_RENAME` | Rename / move a file | `oldPath`, `newPath` |
| `PULL_REQUEST` | Download a file | `path` |
| `PONG` | Keep-alive reply | — |

### Server → Client

| Type | Purpose | Key payload fields |
|------|---------|-------------------|
| `AUTH_OK` | Authenticated | — |
| `AUTH_FAIL` | Auth rejected | `error` |
| `MANIFEST_RESPONSE` | Server manifest | `manifest`, `serverId` |
| `FILE_ACK` | Acknowledge operation | `success`, `mtime`, `error` |
| `PULL_RESPONSE` | File content | `content`, `encoding`, `hash`, `mtime` |
| `FILE_UPSERT` | Broadcast: file changed | `path`, `content`, `encoding`, `hash`, `mtime` |
| `FILE_DELETE` | Broadcast: file deleted | `path` |
| `FILE_RENAME` | Broadcast: file renamed | `oldPath`, `newPath` |
| `CONFLICT_NOTIFY` | Conflict copy created | `originalPath`, `conflictPath` |
| `PING` | Keep-alive (every 15 s) | — |

---

## License

MIT — see [LICENSE](LICENSE)

---

## Acknowledgements

Inspired by [Obsidian Sync](https://obsidian.md/sync) — the conflict copy naming convention and the general sync philosophy are borrowed from it. This plugin is an independent open-source project and is not affiliated with Obsidian.
