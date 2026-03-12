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

const DEBOUNCE_MS = 1000; // 1 s — gives plugins (Meld Encrypt etc.) time to finish writing

export class SyncManager {
  private client: WsClient;
  private manifestManager: ManifestManager;
  private debounceMap = new Map<string, ReturnType<typeof setTimeout>>();
  private started = false;
  private conflictCount = 0;

  /**
   * Set to true during an explicit force-sync so that:
   * 1. Progress notices are shown to the user.
   * 2. delete_local decisions are overridden to push (re-upload) instead,
   *    preventing local files being silently moved to trash when the server
   *    doesn't have them (e.g. after a server rebuild).
   */
  private isForceSyncing = false;

  /**
   * When the user presses Force Sync while the WebSocket is not yet connected
   * (common on Android after returning from background), this flag queues the
   * force sync to run as soon as authentication completes.
   */
  private pendingForceSync = false;

  /**
   * Paths added here are temporarily ignored by handleRename().
   * Used to suppress the loop-back vault rename event that fires when
   * onRemoteRename() calls vault.rename() — without this, Device B would
   * re-send FILE_RENAME back to the server every time it applied a remote rename.
   */
  private suppressedRenames = new Set<string>();

  /**
   * Prevents concurrent runStartupSync() calls.
   * A second startup sync can be triggered if:
   *   • The WS reconnects while a sync is already in progress.
   *   • The user double-clicks the Force Sync button.
   * The second call is silently dropped; the in-flight sync already covers it.
   */
  private isSyncing = false;

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
    this.client.on('authenticated', () => {
      // If a force-sync was requested while we were disconnected, honour it now.
      if (this.pendingForceSync) {
        this.pendingForceSync = false;
        this.doForceSync();
      } else {
        this.runStartupSync();
      }
    });
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
   * Exposed for the ribbon button, settings UI, and command palette.
   *
   * If the WebSocket is not yet connected (common on Android after returning
   * from background), we trigger an immediate reconnect and queue the sync to
   * run on the next 'authenticated' event rather than failing with
   * "WebSocket not connected".
   */
  async runStartupSyncPublic(): Promise<void> {
    if (!this.client.isConnected()) {
      // Queue the force-sync — it will run as soon as auth completes.
      this.pendingForceSync = true;
      this.client.reconnectNow();
      new Notice('VPS Sync: Reconnecting…', 4000);
      return;
    }
    await this.doForceSync();
  }

  /**
   * Run a sync with the force-sync flag active (shows notices, overrides
   * delete_local → push).  Split out so the 'authenticated' path can also
   * trigger it when pendingForceSync is set.
   */
  private async doForceSync(): Promise<void> {
    this.isForceSyncing = true;
    try {
      await this.runStartupSync();
    } finally {
      this.isForceSyncing = false;
    }
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
      testClient.on('authFail', () => { clearTimeout(timer); resolve(false); });
      testClient.on('error',    () => { clearTimeout(timer); resolve(false); });
      testClient.connect();
    });
  }

  // ── Startup sync ──────────────────────────────────────────────────────────

  private async runStartupSync(): Promise<void> {
    // Guard against concurrent syncs (double Force Sync click, WS reconnect
    // firing while a sync is still in progress, etc.)
    if (this.isSyncing) {
      console.log('[VPS Sync] Sync already in progress — skipping concurrent call');
      return;
    }
    this.isSyncing = true;

    this.plugin.statusBar.setStatus('syncing');
    this.conflictCount = 0;
    const CONCURRENCY = 5;

    // Only show the "checking N files" progress notice for manual force syncs.
    const notify = (msg: string, timeout?: number) => {
      if (this.isForceSyncing) new Notice(msg, timeout);
    };

    try {
      // ── 1. Fetch server manifest ───────────────────────────────────────────
      const response = await this.client.sendRequest<ManifestResponsePayload>(
        'MANIFEST_REQUEST', {}, 20000
      );
      const serverManifest: ServerManifest = response.manifest;

      // ── 1b. Server-ID guard ────────────────────────────────────────────────
      // Clear local manifest when the server UUID changes (restart / rebuild)
      // so stale manifest records don't trigger delete_local on files that
      // simply don't exist on the new server yet.
      if (response.serverId && response.serverId !== this.settings.lastServerId) {
        console.log(
          `[VPS Sync] Server ID changed ` +
          `(${this.settings.lastServerId ?? 'none'} → ${response.serverId}). ` +
          'Clearing local manifest.'
        );
        this.manifestManager.clearAll();
        this.settings.lastServerId = response.serverId;
        await this.plugin.saveSettings();
        new Notice('VPS Sync: New server detected — doing a clean full sync.');
      }

      // ── 2. Collect all local file paths ───────────────────────────────────
      // Combine Obsidian's vault index with a raw adapter scan so files with
      // unusual extensions (.mdenc, .canvas, .excalidraw …) are never missed.
      const localFiles = this.plugin.app.vault.getFiles();
      const adapterPaths = await this.scanAllVaultFiles();
      const localPaths = new Set([
        ...localFiles.map(f => f.path),
        ...adapterPaths,
      ]);

      // ── 2b. Rename / move detection pre-scan ──────────────────────────────
      //
      // Build a hash → localPath map for files that exist locally but are NOT
      // on the server.  These are the only candidates for rename targets.
      //
      // We deliberately skip files already on the server (at the same path)
      // to avoid false-positive matches between different files with identical
      // content (e.g. two empty notes, two template copies).
      const localHashToPath = new Map<string, string>();
      const localOnlyPaths = [...localPaths].filter(
        lp => !this.isExcluded(lp) && !serverManifest[lp]
      );
      for (const lp of localOnlyPaths) {
        try {
          const content = await this.readFileBytes(lp);
          if (content) {
            const hash = await ManifestManager.computeHash(content);
            if (!localHashToPath.has(hash)) localHashToPath.set(hash, lp);
          }
        } catch { /* skip unreadable files */ }
      }

      // ── 2c. Resolve renames / moves before the main classify loop ─────────
      //
      // For every server path whose content matches a local-only file, we have
      // two possible explanations:
      //
      //   Case A — local moved, server is behind:
      //     • serverPath WAS in local manifest (we synced it before)
      //     • localOtherPath is NOT in local manifest (user moved it here)
      //     → Send FILE_RENAME to server so it follows local organisation.
      //
      //   Case B — server (another device) moved, this device hasn't caught up:
      //     • serverPath is NOT in local manifest (server moved it to this new path)
      //     • localOtherPath WAS in local manifest (this is the old local path)
      //     → Rename locally to match server.  No round-trip needed.
      //
      //   After clearAll (manifest is empty): treat same as Case B — "server wins".
      //   This avoids push + pull creating duplicates at both old and new paths.
      //
      // Paths handled here are added to handledPaths and skipped by the
      // main classify() loop below.

      const handledPaths = new Set<string>();
      let renamedCount = 0;

      for (const serverOnlyPath of Object.keys(serverManifest)) {
        if (this.isExcluded(serverOnlyPath)) continue;
        if (localPaths.has(serverOnlyPath)) continue;   // file still at same path

        const serverHash = serverManifest[serverOnlyPath].hash;
        const localOtherPath = localHashToPath.get(serverHash);
        if (!localOtherPath) continue;                   // no local file with same content
        if (serverManifest[localOtherPath]) continue;    // server already has a file there

        const serverPathInManifest  = !!this.manifestManager.getRecord(serverOnlyPath);
        const localPathInManifest   = !!this.manifestManager.getRecord(localOtherPath);

        // ── Case A: local moved offline → push the rename to server ─────────
        if (serverPathInManifest && !localPathInManifest) {
          console.log(`[VPS Sync] Case A rename: server "${serverOnlyPath}" → local "${localOtherPath}"`);
          try {
            const ack = await this.client.sendRequest<FileAckPayload>(
              'FILE_RENAME',
              { oldPath: serverOnlyPath, newPath: localOtherPath },
              10000
            );
            if (!ack.success) throw new Error(ack.error ?? 'Rename rejected');

            // Update local manifest
            const oldRec = this.manifestManager.getRecord(serverOnlyPath)!;
            this.manifestManager.deleteRecord(serverOnlyPath);
            this.manifestManager.setRecord(localOtherPath, oldRec);

            // Keep in-memory serverManifest consistent
            serverManifest[localOtherPath] = serverManifest[serverOnlyPath];
            delete serverManifest[serverOnlyPath];

            handledPaths.add(serverOnlyPath);
            handledPaths.add(localOtherPath);
            renamedCount++;
          } catch (e) {
            console.error(`[VPS Sync] Case A rename failed:`, e);
            // Fall through — classify() will handle these paths
          }

        // ── Case B / clearAll: server moved it → apply rename locally ────────
        // Condition: serverPath NOT in manifest (regardless of localPath status).
        // This correctly covers:
        //   • Case B proper: !serverInManifest &&  localInManifest   (server moved, local is behind)
        //   • After clearAll: !serverInManifest && !localInManifest  (server wins)
        // It correctly EXCLUDES: serverInManifest && localInManifest (both known → ambiguous,
        //   let classify() decide rather than blindly renaming).
        } else if (!serverPathInManifest) {
          console.log(`[VPS Sync] Case B rename: local "${localOtherPath}" → "${serverOnlyPath}"`);
          try {
            const file = this.plugin.app.vault.getAbstractFileByPath(localOtherPath);
            if (file) {
              await this.ensureParentFolders(serverOnlyPath);
              // Suppress the vault rename event so handleRename() doesn't
              // echo this back to the server.
              this.suppressedRenames.add(localOtherPath);
              await this.plugin.app.vault.rename(file, serverOnlyPath);
              // 500 ms buffer after debounce so the debounce callback itself
              // (which fires at DEBOUNCE_MS) is still suppressed even if it
              // executes slightly late.
              setTimeout(
                () => this.suppressedRenames.delete(localOtherPath),
                DEBOUNCE_MS + 500
              );
            }

            // Update local manifest
            const oldRec = this.manifestManager.getRecord(localOtherPath);
            if (oldRec) {
              this.manifestManager.deleteRecord(localOtherPath);
              this.manifestManager.setRecord(serverOnlyPath, oldRec);
            } else {
              this.manifestManager.setRecord(serverOnlyPath, {
                hash: serverHash,
                serverMtime: serverManifest[serverOnlyPath].mtime,
                localMtime: Date.now(),
              });
            }

            handledPaths.add(serverOnlyPath);
            handledPaths.add(localOtherPath);
            renamedCount++;
          } catch (e) {
            console.error(`[VPS Sync] Case B rename failed:`, e);
            // Fall through — classify() will handle these paths
          }
        }
        // Both in manifest → ambiguous (e.g. two identical files); let classify handle
      }

      // ── 3. Build work queue ───────────────────────────────────────────────
      // Union of all known paths minus exclusions and already-resolved renames.
      const allPaths = Array.from(new Set([
        ...localPaths,
        ...Object.keys(serverManifest),
        ...this.manifestManager.getAllPaths(),
      ])).filter(p => !this.isExcluded(p) && !handledPaths.has(p));

      const total = allPaths.length;
      notify(`VPS Sync: Checking ${total} files…`, 4000);
      console.log(`[VPS Sync] Startup sync — evaluating ${total} paths`);

      let pushed = 0;
      let pulled = 0;
      let processed = 0;

      // ── 4. Worker: process one path ───────────────────────────────────────
      const processOne = async (path: string): Promise<void> => {
        try {
          const localRecord  = this.manifestManager.getRecord(path);
          const serverRecord = serverManifest[path];
          const localFile    = this.plugin.app.vault.getAbstractFileByPath(path);

          let currentHash = '';
          let localContent: ArrayBuffer | null = null;

          if (localFile instanceof TFile) {
            localContent  = await this.plugin.app.vault.readBinary(localFile);
            currentHash   = await ManifestManager.computeHash(localContent);
          } else if (localPaths.has(path)) {
            // File exists on disk but not yet indexed by Obsidian
            // (unusual extension, or mobile vault still scanning)
            localContent = await this.readFileBytes(path);
            if (localContent) currentHash = await ManifestManager.computeHash(localContent);
          }

          let decision = ConflictResolver.classify(localRecord, serverRecord, currentHash);

          // During a force sync, never silently trash local files.
          // Re-upload them instead so the server catches up with local state.
          // This protects against the case where the server lost data without
          // a serverId change (e.g. manual deletion on server).
          if (this.isForceSyncing && decision === 'delete_local') {
            decision = 'push';
          }

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
              const conflictPath = ConflictResolver.buildConflictPath(path);
              await this.pullFileTo(path, conflictPath);
              if (localContent !== null) {
                await this.pushFileContent(path, localContent, 0);
              }
              this.conflictCount++;
              // Conflicts always shown, even for auto-sync
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
          console.error(`[VPS Sync] Error processing "${path}":`, e);
        }
      };

      // ── 5. Worker-pool: CONCURRENCY workers drain the queue ───────────────
      const queue = [...allPaths];
      const runWorker = async (): Promise<void> => {
        while (queue.length > 0) {
          const path = queue.shift();
          if (!path) break;
          await processOne(path);
          processed++;
          if (processed % 25 === 0) await this.manifestManager.save();
        }
      };
      if (total > 0) {
        await Promise.all(
          Array.from({ length: Math.min(CONCURRENCY, total) }, () => runWorker())
        );
      }

      // ── 6. Finish ─────────────────────────────────────────────────────────
      await this.manifestManager.save();

      const parts: string[] = [];
      if (pushed  > 0) parts.push(`↑${pushed} pushed`);
      if (pulled  > 0) parts.push(`↓${pulled} pulled`);
      if (renamedCount > 0) parts.push(`↔${renamedCount} renamed`);
      if (this.conflictCount > 0) parts.push(`⚠ ${this.conflictCount} conflicts`);

      const summary = parts.length > 0 ? parts.join(', ') : 'up to date';

      // Only tell the user about the result if they asked for a sync, OR if
      // there were actual changes/conflicts during an automatic sync.
      if (this.isForceSyncing || pushed > 0 || pulled > 0 || this.conflictCount > 0) {
        new Notice(`VPS Sync: ${summary}`);
      }
      console.log(`[VPS Sync] Sync done — ${summary}`);

      if (this.conflictCount > 0) {
        this.plugin.statusBar.showConflictBadge(this.conflictCount);
      } else {
        this.plugin.statusBar.setStatus('connected');
      }
    } catch (e) {
      console.error('[VPS Sync] Startup sync error', e);
      this.plugin.statusBar.setStatus('error', String(e));
      // Always show sync errors so the user knows something went wrong.
      new Notice(`VPS Sync: Sync error — ${e}`);
    } finally {
      this.isSyncing = false;
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
    // Suppress the loop-back rename event that fires when onRemoteRename()
    // calls vault.rename() — we don't want to re-echo it to the server.
    if (this.suppressedRenames.has(oldPath)) return;
    if (this.isExcluded(file.path) && this.isExcluded(oldPath)) return;
    this.debounce(file.path, () => this.renameFile(oldPath, file.path));
  }

  // ── Push operations ───────────────────────────────────────────────────────

  private async pushFile(file: TFile): Promise<void> {
    if (!this.client.isConnected()) return;
    try {
      const content = await this.plugin.app.vault.readBinary(file);
      const hash    = await ManifestManager.computeHash(content);
      const existing = this.manifestManager.getRecord(file.path);
      if (existing && existing.hash === hash) return; // unchanged
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
      path, content: encoded, encoding, hash,
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
    if (!this.manifestManager.getRecord(path)) return; // never synced — skip
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
      const ack = await this.client.sendRequest<FileAckPayload>(
        'FILE_RENAME', { oldPath, newPath }, 10000
      );
      // Only update the manifest when the server confirmed the rename.
      if (ack.success) {
        const record = this.manifestManager.getRecord(oldPath);
        if (record) {
          this.manifestManager.deleteRecord(oldPath);
          this.manifestManager.setRecord(newPath, record);
        }
        await this.manifestManager.save();
      } else {
        // Server rejected the rename (e.g. loop-back on same already-done rename).
        // The manifest already reflects reality on this device so nothing to do.
        console.warn(`[VPS Sync] Server rejected rename "${oldPath}" → "${newPath}": ${ack.error ?? 'unknown'}`);
      }
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
      const response = await this.client.sendRequest<PullResponsePayload>(
        'PULL_REQUEST', { path: sourcePath }, 30000
      );
      const content = FileEncoder.decode(response.content, response.encoding);
      const hash    = await ManifestManager.computeHash(content);

      const existing = this.plugin.app.vault.getAbstractFileByPath(destPath);
      if (existing instanceof TFile) {
        await this.plugin.app.vault.modifyBinary(existing, content);
      } else {
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
      // false = vault .trash/ folder (recoverable in Obsidian on all platforms).
      // true  = OS system trash (not accessible from mobile).
      await this.plugin.app.vault.trash(file, false);
    }
    this.manifestManager.deleteRecord(path);
  }

  // ── Remote change handlers (WebSocket push from server) ──────────────────

  private async onRemoteChange(payload: FileUpsertPayload): Promise<void> {
    if (this.isExcluded(payload.path)) return;
    try {
      const existing    = this.plugin.app.vault.getAbstractFileByPath(payload.path);
      const localRecord = this.manifestManager.getRecord(payload.path);

      // Conflict: local was modified since last sync
      if (existing instanceof TFile && localRecord) {
        const localContent = await this.plugin.app.vault.readBinary(existing);
        const localHash    = await ManifestManager.computeHash(localContent);
        if (localHash !== localRecord.hash) {
          const conflictPath = ConflictResolver.buildConflictPath(payload.path);
          const content = FileEncoder.decode(payload.content, payload.encoding);
          await this.ensureParentFolders(conflictPath);
          await this.plugin.app.vault.createBinary(conflictPath, content);
          const cHash = await ManifestManager.computeHash(content);
          this.manifestManager.setRecord(conflictPath, {
            hash: cHash, serverMtime: payload.mtime, localMtime: Date.now(),
          });
          new Notice(`VPS Sync: Conflict on "${payload.path}" — conflict copy created.`);
          this.plugin.statusBar.showConflictBadge(1);
          await this.manifestManager.save();
          return;
        }
      }

      // Safe to apply remote change
      const content = FileEncoder.decode(payload.content, payload.encoding);
      const hash    = await ManifestManager.computeHash(content);

      if (existing instanceof TFile) {
        await this.plugin.app.vault.modifyBinary(existing, content);
      } else {
        await this.ensureParentFolders(payload.path);
        await this.plugin.app.vault.createBinary(payload.path, content);
      }

      const file = this.plugin.app.vault.getAbstractFileByPath(payload.path);
      const localMtime = file instanceof TFile ? file.stat.mtime : Date.now();
      this.manifestManager.setRecord(payload.path, {
        hash, serverMtime: payload.mtime, localMtime,
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
      const existing    = this.plugin.app.vault.getAbstractFileByPath(payload.path);

      // If local was modified after last sync, keep it rather than deleting
      if (existing instanceof TFile && localRecord) {
        const localContent = await this.plugin.app.vault.readBinary(existing);
        const localHash    = await ManifestManager.computeHash(localContent);
        if (localHash !== localRecord.hash) {
          // Local has unsaved changes — keep it, just remove from manifest
          this.manifestManager.deleteRecord(payload.path);
          await this.manifestManager.save();
          return;
        }
      }

      if (existing) {
        // Use vault .trash/ (recoverable on mobile) NOT the OS system trash.
        await this.plugin.app.vault.trash(existing, false);
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
        // Add to suppressedRenames BEFORE calling vault.rename() so the
        // vault 'rename' event fired by this operation is ignored by
        // handleRename() — preventing the loop-back re-send to server.
        this.suppressedRenames.add(payload.oldPath);
        await this.plugin.app.vault.rename(existing, payload.newPath);
        // 500 ms buffer so the debounce callback (fires at DEBOUNCE_MS) is
        // still suppressed even if it executes slightly after its deadline.
        setTimeout(() => this.suppressedRenames.delete(payload.oldPath), DEBOUNCE_MS + 500);
      } else {
        // File doesn't exist locally (was offline when rename happened).
        // Pull the file from its new server location instead.
        await this.pullFile(payload.newPath);
      }

      // Update manifest for the rename
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
   * Handles files with unusual extensions not fully indexed by Obsidian
   * (e.g. .mdenc on some mobile builds).
   */
  private async readFileBytes(path: string): Promise<ArrayBuffer | null> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      return this.plugin.app.vault.readBinary(file);
    }
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
    const SKIP_FOLDERS = new Set(['.obsidian', '.trash']);

    const scan = async (folder: string) => {
      try {
        const result = await this.plugin.app.vault.adapter.list(folder);
        for (const filePath of result.files) {
          paths.push(filePath);
        }
        for (const subFolder of result.folders) {
          const topLevel = subFolder.split('/')[0];
          if (SKIP_FOLDERS.has(topLevel)) continue;
          await scan(subFolder);
        }
      } catch (e) {
        // Log so users/devs know something is wrong, but don't abort the scan.
        console.warn(`[VPS Sync] Could not scan folder "${folder}":`, e);
      }
    };

    await scan('');
    return paths.filter(Boolean);
  }

  private async ensureParentFolders(filePath: string): Promise<void> {
    const parts = filePath.split('/');
    parts.pop(); // remove filename
    if (parts.length === 0) return;
    const folder = parts.join('/');
    if (this.plugin.app.vault.getAbstractFileByPath(folder)) return;
    try {
      await this.plugin.app.vault.createFolder(folder);
    } catch (e) {
      // Suppress only "already exists" — race condition where another op created
      // the folder between our check and the createFolder call.
      const msg = String(e).toLowerCase();
      if (!msg.includes('already exists') && !msg.includes('folder already')) {
        throw e; // real error (e.g. invalid path) — let caller handle it
      }
    }
  }
}
