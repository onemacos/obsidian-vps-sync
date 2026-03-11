#!/bin/bash
# Deploy server to local PC (192.168.68.109)
# Usage: ./deploy-server.sh
set -e

SERVER_USER=root
SERVER_HOST=192.168.68.109
REMOTE_PATH=/opt/vps-sync

echo "[deploy] Syncing server files..."
sshpass -p "shinchan" rsync -az --delete \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='.env' \
  -e "ssh -o StrictHostKeyChecking=no" \
  "$(dirname "$0")/server/" \
  "${SERVER_USER}@${SERVER_HOST}:${REMOTE_PATH}/"

echo "[deploy] Installing dependencies..."
sshpass -p "shinchan" ssh -o StrictHostKeyChecking=no "${SERVER_USER}@${SERVER_HOST}" \
  "cd ${REMOTE_PATH} && npm install --production 2>&1 | tail -2 && pm2 restart vps-sync && pm2 save"

echo "[deploy] Done! Server status:"
sshpass -p "shinchan" ssh -o StrictHostKeyChecking=no "${SERVER_USER}@${SERVER_HOST}" "pm2 status"
