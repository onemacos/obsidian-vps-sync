import { Notice, TFile, TAbstractFile } from 'obsidian';
import type VpsSyncPlugin from './main';
import { WsClient } from './ws-client';
import { ManifestManager } from './manifest-manager';
import { ConflictResolver } from './conflict-resolver';
import { FileEncoder } from './file-encoder';
import type {
  VpsSyncSettings,
  ServerManifest,
  ManifestResponsePayload,
  FileUpsertPayload,
  FileDeletePayload,
  FileRenamePayload,
  ConflictNotifyPayload,
  FileAckPayload,
  PullResponsePayload,
} from './types';

// Minimalist glob matcher (supports ** and *)
function globMatch(pattern: string, path: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex chars (not * or ?)
    .replace(/\*\*/g, '§§')               // temp placeholder
    .replace(/\*/g, '[^/]*')              // single * matches one segment
    .replace(/§§/g, '.*');               // ** matches anything
  return new RegExp(`^${regexStr}$`).test(path);
}

const DEBOUNCE_MS = 500;

export class SyncManager {
  private client: WsClient;
  private manifestManager: ManifestManager;
  private debounceMap = new Map<string, ReturnType<typeof setTimeout>>();
  private started = false;
  private conflictCount = 0;

  constructor(
    private plugin: VpsSyncPlugin,
    private settings: VpsSyncSettings
  ) {
    this.client = new WsClient(settings);
    this.manifestManager = new ManifestManager();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    await this.manifestManager.load(this.plugin);

    // Wire up WS events
    this.client.on('statusChange', s => this.plugin.statusBar.setStatus(s));
    this.client.on('authenticated', () => this.runStartupSync());
    this.client.on('authFail', msg => {
      this.plugin.statusBar.setStatus('error', 'auth failed');
      new Notice(`VPS Sync: Auth failed — ${msg}`);
    });
    this.client.on('remoteChange', p => this.onRemoteChange(p));
    this.client.on('remoteDelete', p => this.onRemoteDelete(p));
    this.client.on('remoteRename', p => this.onRemoteRename(p));
    this.client.on('conflictNotify', p => this.onConflictNotify(p));
    this.client.on('error', msg => console.error('[VPS Sync]', msg));

    // Register vault events
    this.plugin.registerEvent(
      this.plugin.app.vault.on('create', file => this.handleCreate(file))
    );
    this.plugin.registerEvent(
      this.plugin.app.vault.on('modify', file => this.handleModify(file))
    );
    this.plugin.registerEvent(
      this.plugin.app.vault.on('delete', file => this.handleDelete(file))
    );
    this.plugin.registerEvent(
      this.plugin.app.vault.on('rename', (file, oldPath) => this.handleRename(file, oldPath))
    );

    this.client.connect();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.debounceMap.forEach(t => clearTimeout(t));
    this.debounceMap.clear();
    this.client.disconnect();
  }

  // ── Public helpers ────────────────────────────────────────────────────────

  /**
   * Exposed for the settings UI "Force Full Sync" button and command palette.
   * Clears the in-memory manifest first so EVERY file is re-evaluated from
   * scratch — not just files that differ from the cached manifest records.
   * Without clearing, files already tracked with matching hashes would silently
   * be treated as 'noop' even if the server no longer has them.
   */
  async runStartupSyncPublic(): Promise<void> {
    this.manifestManager.clearAll();
    await this.runStartupSync();
  }

  async testConnection(): Promise<boolean> {
    return new Promise(resolve => {
      const testClient = new WsClient(this.settings);
      const timer = setTimeout(() => {
        testClient.disconnect();
        resolve(false);
      }, 8000);

      testClient.on('authenticated', () => {
        clearTimeout(timer);
        testClient.disconnect();
        resolve(true);
      });
      testClient.on('authFail', () => {
        clearTimeout(timer);
        resolve(false);
      });
      testClient.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
      testClient.connect();
    });
  }

  // ── Startup sync ──────────────────────────────────────────────────────────

  private async runStartupSync(): Promise<void> {
    this.plugin.statusBar.setStatus('syncing');
    this.conflictCount = 0;
    const CONCURRENCY = 5;

    try {
      // 1. Fetch server manifest
      const response = await this.client.sendRequest<ManifestResponsePayload>(
        'MANIFEST_REQUEST',
        {},
        20000
      );
      const serverManifest: ServerManifest = response.manifest;

      // 1b. Server-ID guard — if this is a new/different server, wipe the local
      //     manifest first so stale manifest records don't trigger delete_local on
      //     files that simply don't exist on the new server yet.
      if (response.serverId && response.serverId !== this.settings.lastServerId) {
        console.log(
          `[VPS Sync] Server ID changed (${this.settings.lastServerId ?? 'none'} → ${response.serverId}). ` +
          'Clearing local manifest to prevent stale delete_local decisions.'
        );
        this.manifestManager.clearAll();
        this.settings.lastServerId = response.serverId;
        await this.plugin.saveSettings();
        new Notice('VPS Sync: New server detected — doing a clean full sync.');
      }

      // 2. Collect all local files — vault index + full adapter scan so that
      //    files with unusual extensions (.mdenc, .canvas, .excalidraw …) are never missed.
      const localFiles = this.plugin.app.vault.getFiles();
      const adapterPaths = await this.scanAllVaultFiles();
      const localPaths = new Set([
        ...localFiles.map(f => f.path),
        ...adapterPaths,
      ]);

      // 3. Build the full work queue: union of local + server + manifest paths, minus exclusions
      const allPaths = Array.from(new Set([
        ...localPaths,
        ...Object.keys(serverManifest),
        ...this.manifestManager.getAllPaths(),
      ])).filter(p => !this.isExcluded(p));

      const total = allPaths.length;
      new Notice(`VPS Sync: Checking ${total} files…`, 4000);
      console.log(`[VPS Sync] Startup sync — evaluating ${total} paths`);

      let pushed = 0;
      let pulled = 0;
      let processed = 0;

      // 4. Worker: processes one file path at a time from the shared queue
      const processOne = async (path: string): Promise<void> => {
        try {
          const localRecord = this.manifestManager.getRecord(path);
          const serverRecord = serverManifest[path];
          const localFile = this.plugin.app.vault.getAbstractFileByPath(path);

          let currentHash = '';
          let localContent: ArrayBuffer | null = null;

          if (localFile instanceof TFile) {
            localContent = await this.plugin.app.vault.readBinary(localFile);
            currentHash = await ManifestManager.computeHash(localContent);
          } else if (localPaths.has(path)) {
            // File exists on disk but not yet indexed by Obsidian (unusual extension)
            localContent = await this.readFileBytes(path);
            if (localContent) currentHash = await ManifestManager.computeHash(localContent);
          }

          const decision = ConflictResolver.classify(localRecord, serverRecord, currentHash);
          console.log(`[VPS Sync] ${decision.padEnd(16)} ${path}`);

          switch (decision) {
            case 'push':
              if (localContent !== null) {
                await this.pushFileContent(path, localContent, localRecord?.serverMtime ?? 0);
                pushed++;
              }
              break;

            case 'pull':
              await this.pullFile(path);
              pulled++;
              break;

            case 'conflict': {
              // Pull server version to a conflict copy, keep local at original path
              const conflictPath = ConflictResolver.buildConflictPath(path);
              await this.pullFileTo(path, conflictPath);
              if (localContent !== null) {
                await this.pushFileContent(path, localContent, 0);
              }
              this.conflictCount++;
              new Notice(`VPS Sync: Conflict on "${path}" — conflict copy created.`);
              break;
            }

            case 'delete_local':
              await this.deleteLocalFile(path);
              break;

            case 'delete_remote':
              await this.client.sendRequest<FileAckPayload>('FILE_DELETE', { path }, 10000);
              this.manifestManager.deleteRecord(path);
              break;

            case 'cleanup_manifest':
              this.manifestManager.deleteRecord(path);
              break;

            case 'noop':
            default:
              break;
          }
        } catch (e) {
          // A single file failure must not abort the rest of the sync
          console.error(`[VPS Sync] Error processing "${path}":`, e);
        }
      };

      // 5. Worker-pool: CONCURRENCY workers drain the queue simultaneously
      const queue = [...allPaths];
      const runWorker = async (): Promise<void> => {
        while (queue.length > 0) {
          const path = queue.shift();
          if (!path) break;
          await processOne(path);
          processed++;
          // Incremental manifest save every 25 files to preserve progress on
          // interruption (e.g. Obsidian closed mid-sync)
          if (processed % 25 === 0) {
            await this.manifestManager.save();
          }
        }
      };

      if (total > 0) {
        await Promise.all(
          Array.from({ length: Math.min(CONCURRENCY, total) }, () => runWorker())
        );
      }

      // 6. Final save + summary
      await this.manifestManager.save();

      const summary = `↑${pushed} pushed, ↓${pulled} pulled` +
        (this.conflictCount > 0 ? `, ⚠ ${this.conflictCount} conflicts` : '');
      new Notice(`VPS Sync: Sync complete — ${summary}`);
      console.log(`[VPS Sync] Sync done — ${summary}`);

      if (this.conflictCount > 0) {
        this.plugin.statusBar.showConflictBadge(this.conflictCount);
      } else {
        this.plugin.statusBar.setStatus('connected');
      }
    } catch (e) {
      console.error('[VPS Sync] Startup sync error', e);
      this.plugin.statusBar.setStatus('error', String(e));
      new Notice(`VPS Sync: Sync error — ${e}`);
    }
  }

  // ── Vault event handlers ──────────────────────────────────────────────────

  private handleCreate(file: TAbstractFile): void {
    if (!(file instanceof TFile)) return;
    if (this.isExcluded(file.path)) return;
    this.debounce(file.path, () => this.pushFile(file));
  }

  private handleModify(file: TAbstractFile): void {
    if (!(file instanceof TFile)) return;
    if (this.isExcluded(file.path)) return;
    this.debounce(file.path, () => this.pushFile(file));
  }

  private handleDelete(file: TAbstractFile): void {
    if (this.isExcluded(file.path)) return;
    this.debounce(file.path, () => this.deleteFile(file.path));
  }

  private handleRename(file: TAbstractFile, oldPath: string): void {
    if (this.isExcluded(file.path) && this.isExcluded(oldPath)) return;
    this.debounce(file.path, () => this.renameFile(oldPath, file.path));
  }

  // ── Push operations ───────────────────────────────────────────────────────

  private async pushFile(file: TFile): Promise<void> {
    if (!this.client.isConnected()) return;
    try {
      const content = await this.plugin.app.vault.readBinary(file);
      const hash = await ManifestManager.computeHash(content);

      const existing = this.manifestManager.getRecord(file.path);
      if (existing && existing.hash === hash) return; // no change

      await this.pushFileContent(file.path, content, existing?.serverMtime ?? 0);
      await this.manifestManager.save();
    } catch (e) {
      console.error(`[VPS Sync] pushFile error for ${file.path}`, e);
    }
  }

  private async pushFileContent(
    path: string,
    content: ArrayBuffer,
    knownServerMtime: number
  ): Promise<void> {
    const hash = await ManifestManager.computeHash(content);
    const { encoded, encoding } = FileEncoder.encode(content, path);

    const payload: FileUpsertPayload = {
      path,
      content: encoded,
      encoding,
      hash,
      mtime: Date.now(),
      serverMtime: knownServerMtime,
    };

    const ack = await this.client.sendRequest<FileAckPayload>('FILE_UPSERT', payload, 30000);
    if (ack.success) {
      const file = this.plugin.app.vault.getAbstractFileByPath(path);
      const localMtime = file instanceof TFile ? file.stat.mtime : Date.now();
      this.manifestManager.setRecord(path, {
        hash,
        serverMtime: ack.mtime ?? Date.now(),
        localMtime,
      });
    }
  }

  private async deleteFile(path: string): Promise<void> {
    if (!this.client.isConnected()) return;
    if (!this.manifestManager.getRecord(path)) return; // never synced
    try {
      await this.client.sendRequest<FileAckPayload>('FILE_DELETE', { path }, 10000);
      this.manifestManager.deleteRecord(path);
      await this.manifestManager.save();
    } catch (e) {
      console.error(`[VPS Sync] deleteFile error for ${path}`, e);
    }
  }

  private async renameFile(oldPath: string, newPath: string): Promise<void> {
    if (!this.client.isConnected()) return;
    try {
      await this.client.sendRequest<FileAckPayload>('FILE_RENAME', { oldPath, newPath }, 10000);
      const record = this.manifestManager.getRecord(oldPath);
      if (record) {
        this.manifestManager.deleteRecord(oldPath);
        this.manifestManager.setRecord(newPath, record);
      }
      await this.manifestManager.save();
    } catch (e) {
      console.error(`[VPS Sync] renameFile error`, e);
    }
  }

  // ── Pull operations ───────────────────────────────────────────────────────

  private async pullFile(path: string): Promise<void> {
    await this.pullFileTo(path, path);
  }

  private async pullFileTo(sourcePath: string, destPath: string): Promise<void> {
    if (!this.client.isConnected()) return;
    try {
      // Do NOT put a custom requestId in the payload — sendRequest generates
      // the WS-level requestId and the server must echo that same ID back.
      const response = await this.client.sendRequest<PullResponsePayload>(
        'PULL_REQUEST',
        { path: sourcePath },
        30000
      );

      const content = FileEncoder.decode(response.content, response.encoding);
      const hash = await ManifestManager.computeHash(content);

      const existing = this.plugin.app.vault.getAbstractFileByPath(destPath);
      if (existing instanceof TFile) {
        await this.plugin.app.vault.modifyBinary(existing, content);
      } else {
        // Create parent folders if needed
        await this.ensureParentFolders(destPath);
        await this.plugin.app.vault.createBinary(destPath, content);
      }

      const file = this.plugin.app.vault.getAbstractFileByPath(destPath);
      const localMtime = file instanceof TFile ? file.stat.mtime : Date.now();
      this.manifestManager.setRecord(destPath, {
        hash,
        serverMtime: response.mtime,
        localMtime,
      });
    } catch (e) {
      console.error(`[VPS Sync] pullFile error for ${sourcePath}`, e);
    }
  }

  private async deleteLocalFile(path: string): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (file) {
      // Use vault .trash/ (false) not system trash (true) — keeps files recoverable
      // from within Obsidian itself on all platforms including mobile.
      await this.plugin.app.vault.trash(file, false);
    }
    this.manifestManager.deleteRecord(path);
  }

  // ── Remote change handlers (WebSocket push from server) ──────────────────

  private async onRemoteChange(payload: FileUpsertPayload): Promise<void> {
    if (this.isExcluded(payload.path)) return;

    try {
      // Check if local file has unsaved changes
      const existing = this.plugin.app.vault.getAbstractFileByPath(payload.path);
      const localRecord = this.manifestManager.getRecord(payload.path);

      if (existing instanceof TFile && localRecord) {
        const localContent = await this.plugin.app.vault.readBinary(existing);
        const localHash = await ManifestManager.computeHash(localContent);
        if (localHash !== localRecord.hash) {
          // Local has unsaved changes — conflict
          const conflictPath = ConflictResolver.buildConflictPath(payload.path);
          const content = FileEncoder.decode(payload.content, payload.encoding);
          await this.ensureParentFolders(conflictPath);
          await this.plugin.app.vault.createBinary(conflictPath, content);
          const cHash = await ManifestManager.computeHash(content);
          this.manifestManager.setRecord(conflictPath, {
            hash: cHash,
            serverMtime: payload.mtime,
            localMtime: Date.now(),
          });
          new Notice(`VPS Sync: Conflict on "${payload.path}" — conflict copy created.`);
          this.plugin.statusBar.showConflictBadge(1);
          await this.manifestManager.save();
          return;
        }
      }

      // Safe to apply
      const content = FileEncoder.decode(payload.content, payload.encoding);
      const hash = await ManifestManager.computeHash(content);

      if (existing instanceof TFile) {
        await this.plugin.app.vault.modifyBinary(existing, content);
      } else {
        await this.ensureParentFolders(payload.path);
        await this.plugin.app.vault.createBinary(payload.path, content);
      }

      const file = this.plugin.app.vault.getAbstractFileByPath(payload.path);
      const localMtime = file instanceof TFile ? file.stat.mtime : Date.now();
      this.manifestManager.setRecord(payload.path, {
        hash,
        serverMtime: payload.mtime,
        localMtime,
      });
      await this.manifestManager.save();
    } catch (e) {
      console.error(`[VPS Sync] onRemoteChange error for ${payload.path}`, e);
    }
  }

  private async onRemoteDelete(payload: FileDeletePayload): Promise<void> {
    if (this.isExcluded(payload.path)) return;
    try {
      const localRecord = this.manifestManager.getRecord(payload.path);
      const existing = this.plugin.app.vault.getAbstractFileByPath(payload.path);

      if (existing instanceof TFile && localRecord) {
        const localContent = await this.plugin.app.vault.readBinary(existing);
        const localHash = await ManifestManager.computeHash(localContent);
        if (localHash !== localRecord.hash) {
          // Local was modified — keep it, just remove from manifest
          new Notice(`VPS Sync: "${payload.path}" was deleted remotely but has local changes — kept locally.`);
          this.manifestManager.deleteRecord(payload.path);
          await this.manifestManager.save();
          return;
        }
      }

      if (existing) {
        await this.plugin.app.vault.trash(existing, true);
      }
      this.manifestManager.deleteRecord(payload.path);
      await this.manifestManager.save();
    } catch (e) {
      console.error(`[VPS Sync] onRemoteDelete error`, e);
    }
  }

  private async onRemoteRename(payload: FileRenamePayload): Promise<void> {
    try {
      const existing = this.plugin.app.vault.getAbstractFileByPath(payload.oldPath);
      if (existing) {
        await this.ensureParentFolders(payload.newPath);
        await this.plugin.app.vault.rename(existing, payload.newPath);
      }
      const record = this.manifestManager.getRecord(payload.oldPath);
      if (record) {
        this.manifestManager.deleteRecord(payload.oldPath);
        this.manifestManager.setRecord(payload.newPath, record);
      }
      await this.manifestManager.save();
    } catch (e) {
      console.error(`[VPS Sync] onRemoteRename error`, e);
    }
  }

  private onConflictNotify(payload: ConflictNotifyPayload): void {
    // Server already created conflict copy — pull it locally
    this.pullFile(payload.conflictPath).catch(console.error);
    new Notice(`VPS Sync: Conflict on "${payload.originalPath}" — conflict copy created.`);
    this.plugin.statusBar.showConflictBadge(1);
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  private isExcluded(path: string): boolean {
    return this.settings.excludePatterns.some(pattern => globMatch(pattern, path));
  }

  private debounce(path: string, fn: () => void): void {
    const existing = this.debounceMap.get(path);
    if (existing) clearTimeout(existing);
    this.debounceMap.set(
      path,
      setTimeout(() => {
        this.debounceMap.delete(path);
        fn();
      }, DEBOUNCE_MS)
    );
  }

  /**
   * Read file bytes using vault API first, with adapter fallback.
   * Handles files with unusual extensions not fully indexed by Obsidian.
   */
  private async readFileBytes(path: string): Promise<ArrayBuffer | null> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      return this.plugin.app.vault.readBinary(file);
    }
    // Fallback: read directly via adapter for unindexed files
    try {
      return await this.plugin.app.vault.adapter.readBinary(path);
    } catch {
      return null;
    }
  }

  /**
   * Recursively scan the entire vault via the filesystem adapter.
   * Returns all file paths relative to vault root.
   *
   * IMPORTANT: must use '' (empty string) for vault root — NOT '/'.
   * Using '/' causes adapter to return paths with double leading slashes (e.g.
   * '//Notes/file.md'), which after stripping one slash become '/Notes/file.md'.
   * The server's sanitizePath() then rejects these as absolute paths and closes
   * the WebSocket, causing a disconnect/reconnect loop.
   */
  private async scanAllVaultFiles(): Promise<string[]> {
    const paths: string[] = [];

    // Folders to never descend into (Obsidian system + OS trash)
    const SKIP_FOLDERS = new Set(['.obsidian', '.trash']);

    const scan = async (folder: string) => {
      try {
        const result = await this.plugin.app.vault.adapter.list(folder);
        for (const filePath of result.files) {
          paths.push(filePath);
        }
        for (const subFolder of result.folders) {
          // subFolder is relative e.g. 'Notes', 'Notes/sub', '.obsidian'
          // Check both the full path and just the top-level name
          const topLevel = subFolder.split('/')[0];
          if (SKIP_FOLDERS.has(topLevel)) continue;
          await scan(subFolder);
        }
      } catch {
        // Ignore unreadable folders (permissions, etc.)
      }
    };

    // Use '' (vault root) — NOT '/' which causes double-slash path corruption
    await scan('');
    return paths.filter(Boolean);
  }

  private async ensureParentFolders(filePath: string): Promise<void> {
    const parts = filePath.split('/');
    parts.pop(); // remove filename
    if (parts.length === 0) return;
    const folder = parts.join('/');
    const existing = this.plugin.app.vault.getAbstractFileByPath(folder);
    if (!existing) {
      await this.plugin.app.vault.createFolder(folder).catch(() => {/* already exists */});
    }
  }
}
