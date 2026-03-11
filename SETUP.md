# Obsidian VPS Sync — Setup Guide

Real-time vault sync to your own VPS over WebSocket.
- Syncs on every file save (debounced 500ms)
- Conflict copies when both sides change: `Note (conflict 2026-03-11T14-32-00).md`
- Binary files supported (images, PDFs, etc.)
- Multi-device: all connected clients receive changes in real-time

---

## Part 1: VPS Server Setup (Ubuntu)

### 1.1 Install Node.js 20 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs build-essential git
node --version   # should show v20.x.x
```

### 1.2 Install PM2

```bash
sudo npm install -g pm2
```

### 1.3 Create vault storage and system user

```bash
# Dedicated system user (no login shell)
sudo useradd --system --no-create-home --shell /usr/sbin/nologin vpsync

# Vault storage directory
sudo mkdir -p /opt/vault
sudo chown vpsync:vpsync /opt/vault
sudo chmod 750 /opt/vault

# Log directory
sudo mkdir -p /var/log/vps-sync
sudo chown $USER:$USER /var/log/vps-sync
```

### 1.4 Deploy the server

```bash
# From your local machine, copy the server folder to VPS
scp -r obsidian-vps-sync/server/ user@YOUR_VPS_IP:/opt/vps-sync

# On the VPS
cd /opt/vps-sync
npm install
npm run build
```

### 1.5 Configure environment

```bash
cp .env.example .env
nano .env
```

Fill in your `.env`:
```
API_KEY=<generate with: openssl rand -hex 32>
PORT=3241
VAULT_PATH=/opt/vault
NODE_ENV=production
```

```bash
chmod 600 .env
```

### 1.6 Start with PM2

```bash
cd /opt/vps-sync

# Start
pm2 start ecosystem.config.js

# Configure autostart on boot
pm2 startup systemd
# Run the command PM2 outputs, then:
pm2 save

# Check status
pm2 status
pm2 logs vps-sync
```

### 1.7 Open firewall port

```bash
sudo ufw allow OpenSSH
sudo ufw allow 3241/tcp
sudo ufw enable
sudo ufw status
```

### 1.8 (Recommended) Nginx + TLS with Let's Encrypt

This allows using `wss://yourdomain.com` on port 443.

```bash
sudo apt install -y nginx certbot python3-certbot-nginx

# Create /etc/nginx/sites-available/vps-sync:
sudo nano /etc/nginx/sites-available/vps-sync
```

Paste:
```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://localhost:3241;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
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

Plugin URL becomes: `wss://yourdomain.com`

---

## Part 2: Plugin Build & Installation

### 2.1 Build the plugin

```bash
cd obsidian-vps-sync/plugin
npm install
npm run build
# → generates main.js
```

### 2.2 Install into Obsidian

```bash
# Replace /path/to/your/vault with your actual vault path
VAULT=/path/to/your/vault
mkdir -p "$VAULT/.obsidian/plugins/vps-sync"
cp main.js manifest.json "$VAULT/.obsidian/plugins/vps-sync/"
```

### 2.3 Enable in Obsidian

1. Open Obsidian → Settings → Community Plugins
2. Turn off "Restricted mode" (if on)
3. Find "VPS Sync" → toggle ON

### 2.4 Configure the plugin

Settings → VPS Sync:
- **Server URL**: `wss://yourserver.com:3241` (or `wss://yourdomain.com` if using Nginx)
- **API Key**: the key from your `.env` file
- Click **Test Connection** to verify

---

## Part 3: Development

### Plugin hot-reload

```bash
cd plugin
npm run dev   # watches and rebuilds main.js on change
```

In Obsidian, install the "Hot Reload" community plugin for automatic plugin reload on main.js change.

### Server development

```bash
cd server
npm run dev   # ts-node-dev with hot reload
```

Server listens on localhost:3241. Set plugin URL to `ws://localhost:3241` for local testing.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "Auth failed" notice | Check API key matches between .env and plugin settings |
| Status bar shows "disconnected" | Check server is running (`pm2 status`), firewall allows port 3241 |
| Files not syncing | Check exclude patterns in plugin settings; check PM2 logs |
| Conflict copies accumulating | Expected behavior — review and delete unwanted copies |
| Plugin not loading | Verify main.js and manifest.json are in correct folder |

### Check server logs

```bash
pm2 logs vps-sync --lines 50
# or
tail -f /var/log/vps-sync/combined.log
```

### Generate a strong API key

```bash
openssl rand -hex 32
```
