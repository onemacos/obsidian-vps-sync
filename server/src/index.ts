import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import { createAuthMiddleware } from './auth';
import { FileManager } from './file-manager';
import { ServerManifestManager } from './manifest-manager';
import { WsHandler } from './ws-handler';

const API_KEY     = process.env.API_KEY     || '';
const PORT        = parseInt(process.env.PORT ?? '3241', 10);
const VAULT_PATH  = process.env.VAULT_PATH  || '/opt/vault';
const BACKUP_PATH = process.env.BACKUP_PATH || '/opt/vault-backups';
// Manifest is stored OUTSIDE the vault root so it never appears as a vault file.
// Override with MANIFEST_PATH env var if needed.
const MANIFEST_PATH = process.env.MANIFEST_PATH || path.join(BACKUP_PATH, 'manifest.json');

// Unique ID for this server instance.  Clients compare this against their
// stored lastServerId; a mismatch means a new/fresh server so they clear
// their local manifest to prevent stale delete_local decisions.
const SERVER_ID = randomUUID();

if (!API_KEY) {
  console.error('[VPS Sync] ERROR: API_KEY is not set. Refusing to start.');
  process.exit(1);
}

const app = express();
app.use(express.json());

const authMiddleware = createAuthMiddleware(API_KEY);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', authMiddleware, (_req, res) => {
  res.json({
    status:         'ok',
    uptime:         process.uptime(),
    vault:          VAULT_PATH,
    backup:         BACKUP_PATH,
    manifestPath:   MANIFEST_PATH,
    manifestFiles:  manifestManager.size(),
    serverId:       SERVER_ID,
  });
});

// ── Manifest debug / force-rebuild ────────────────────────────────────────────
// GET  /debug/manifest         — show current in-memory manifest state
// POST /debug/manifest/rebuild — force a fresh vault scan (same as MANIFEST_REBUILD WS command)
app.get('/debug/manifest', authMiddleware, (_req, res) => {
  const manifest = manifestManager.getManifest();
  res.json({
    fileCount:    Object.keys(manifest).length,
    manifestPath: MANIFEST_PATH,
    vaultPath:    VAULT_PATH,
    serverId:     SERVER_ID,
    files:        manifest,
  });
});

app.post('/debug/manifest/rebuild', authMiddleware, async (_req, res) => {
  try {
    const count = await manifestManager.buildFromDisk(fileManager);
    res.json({ success: true, fileCount: count, message: `Manifest rebuilt: ${count} files found` });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
  }
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
const manifestManager = new ServerManifestManager(MANIFEST_PATH);
const wsHandler       = new WsHandler(wss, fileManager, manifestManager, API_KEY, SERVER_ID);

(async () => {
  // Ensure required directories exist
  await fs.mkdir(VAULT_PATH,  { recursive: true });
  await fs.mkdir(BACKUP_PATH, { recursive: true });

  // ── Manifest startup strategy ──────────────────────────────────────────────
  // 1. Try to load the persisted JSON manifest (fast, survives restarts).
  // 2. Always follow up with a full disk scan to catch any files that were
  //    added, modified, or deleted while the server was offline.
  // 3. If the disk scan returns 0 files but the JSON had entries, warn loudly
  //    (likely a wrong VAULT_PATH or permission issue) and keep the JSON data.
  const jsonLoaded   = await manifestManager.load();
  const jsonCount    = manifestManager.size();

  console.log(`[VPS Sync] Scanning vault for changes: ${VAULT_PATH}`);
  const diskCount = await manifestManager.buildFromDisk(fileManager);

  if (diskCount === 0 && jsonCount > 0) {
    // Disk scan found nothing but the persisted manifest had files.
    // This usually means VAULT_PATH is wrong or files are inaccessible.
    // Re-load the JSON so clients get the last-known state rather than empty.
    console.warn(
      `[VPS Sync] WARNING: vault scan found 0 files but persisted manifest had ${jsonCount}.` +
      ' Check VAULT_PATH and directory permissions. Falling back to persisted manifest.'
    );
    await manifestManager.load();
  }

  wsHandler.initialize();

  httpServer.listen(PORT, () => {
    console.log(`[VPS Sync] Server listening on port ${PORT}`);
    console.log(`[VPS Sync] Vault:     ${VAULT_PATH}`);
    console.log(`[VPS Sync] Backups:   ${BACKUP_PATH}`);
    console.log(`[VPS Sync] Manifest:  ${MANIFEST_PATH}`);
    console.log(`[VPS Sync] Files:     ${manifestManager.size()}`);
    console.log(`[VPS Sync] Connect:   ws://YOUR_IP:${PORT}`);
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
