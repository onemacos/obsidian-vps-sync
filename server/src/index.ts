import 'dotenv/config';
import fs from 'fs/promises';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { createAuthMiddleware } from './auth';
import { FileManager } from './file-manager';
import { ServerManifestManager } from './manifest-manager';
import { WsHandler } from './ws-handler';

const API_KEY     = process.env.API_KEY     || '';
const PORT        = parseInt(process.env.PORT ?? '3241', 10);
const VAULT_PATH  = process.env.VAULT_PATH  || '/opt/vault';
const BACKUP_PATH = process.env.BACKUP_PATH || '/opt/vault-backups';

if (!API_KEY) {
  console.error('[VPS Sync] ERROR: API_KEY is not set. Refusing to start.');
  process.exit(1);
}

const app = express();
app.use(express.json());

const authMiddleware = createAuthMiddleware(API_KEY);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', authMiddleware, (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), vault: VAULT_PATH, backup: BACKUP_PATH });
});

// ── Backup list: GET /backups/<relative/path/to/file> ─────────────────────────
// Returns all backup versions for a specific file, newest first.
// Example: curl -H "x-api-key: ..." http://server:3241/backups/Notes/daily.md
app.get('/backups/*', authMiddleware, async (req, res) => {
  const filePath = req.params[0] as string;
  if (!filePath) {
    res.status(400).json({ error: 'File path required' });
    return;
  }
  try {
    const backups = await fileManager.listBackups(filePath);
    res.json({ path: filePath, count: backups.length, backups });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── Backup restore: POST /restore/<timestamp>/<relative/path> ─────────────────
// Restores a specific version. The current file is backed up before restoring.
// Example: curl -X POST -H "x-api-key: ..." http://server:3241/restore/2026-03-11T14-32-00/Notes/daily.md
app.post('/restore/:timestamp/*', authMiddleware, async (req, res) => {
  const { timestamp } = req.params;
  const filePath = req.params[0] as string;
  if (!filePath || !timestamp) {
    res.status(400).json({ error: 'Both timestamp and file path are required' });
    return;
  }
  try {
    const result = await fileManager.restoreBackup(filePath, timestamp);
    // Refresh server manifest after restore
    await manifestManager.buildFromDisk(fileManager);
    console.log(`[VPS Sync] Restored ${filePath} from backup ${timestamp}`);
    res.json({ success: true, path: filePath, timestamp, mtime: result.mtime });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 404 for everything else
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

const fileManager     = new FileManager(VAULT_PATH, BACKUP_PATH);
const manifestManager = new ServerManifestManager();
const wsHandler       = new WsHandler(wss, fileManager, manifestManager, API_KEY);

(async () => {
  // Ensure required directories exist
  await fs.mkdir(VAULT_PATH,  { recursive: true });
  await fs.mkdir(BACKUP_PATH, { recursive: true });

  console.log(`[VPS Sync] Building file manifest from ${VAULT_PATH}…`);
  await manifestManager.buildFromDisk(fileManager);

  wsHandler.initialize();

  httpServer.listen(PORT, () => {
    console.log(`[VPS Sync] Server listening on port ${PORT}`);
    console.log(`[VPS Sync] Vault:   ${VAULT_PATH}`);
    console.log(`[VPS Sync] Backups: ${BACKUP_PATH}`);
    console.log(`[VPS Sync] Connect: ws://YOUR_IP:${PORT}`);
  });
})();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[VPS Sync] SIGTERM — shutting down');
  httpServer.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  console.log('[VPS Sync] SIGINT — shutting down');
  httpServer.close(() => process.exit(0));
});
