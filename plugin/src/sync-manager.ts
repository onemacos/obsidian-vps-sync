import { Notice, TFile, TAbstractFile } from 'obsidian';
import type VpsSyncPlugin from './main';
import { WsClient } from './ws-client';
import { ManifestManager } from './manifest-manager';
import { ConflictResolver } from './conflict-resolver';
import { FileEncoder } from './file-encoder';
import { BaseContentStore } from './base-store';
import { merge3, isMergeableFile } from './diff3';
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
   * Set to true during an explicit force-sync so that progress notices are
   * shown to the user.
   *
   * NOTE: We intentionally do NOT override delete_local decisions during a
   * force sync.  Server data loss after a full rebuild is already handled by
   * the serverId guard (which calls clearAll() so deleted files are reclassified
   * as 'push').  Overriding delete_local → push here caused deleted files to
   * reappear: Device B force-syncs while offline, sees a file the server already
   * deleted, re-uploads it, and it reappears on every other device.
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

  /**
   * Conflict copy cooldown (rclone-inspired).
   * Maps path → timestamp of the last conflict copy created for that path.
   * During continuous active editing, multiple remote pushes can arrive within
   * seconds of each other.  Without a cooldown, each one creates a new conflict
   * copy, flooding the vault.  We suppress duplicate copies for the same file
   * within CONFLICT_COOLDOWN_MS.
   */
  private lastConflictTime = new Map<string, number>();
  private static readonly CONFLICT_COOLDOWN_MS = 10_000; // 10 s between copies

  private baseStore!: BaseContentStore;

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
    this.baseStore = new BaseContentStore(this.plugin);

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
          const lpFile   = this.plugin.app.vault.getAbstractFileByPath(lp);
          const lpRecord = this.manifestManager.getRecord(lp);
          let hash: string;
          // rclone-style: reuse stored hash if mtime unchanged since last sync
          if (lpFile instanceof TFile && lpRecord && lpFile.stat.mtime === lpRecord.localMtime) {
            hash = lpRecord.hash;
          } else {
            const content = await this.readFileBytes(lp);
            if (!content) continue;
            hash = await ManifestManager.computeHash(content);
          }
          if (!localHashToPath.has(hash)) localHashToPath.set(hash, lp);
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

      // ── Safety pre-scan (rclone-inspired, skipped during Force Sync) ─────
      //
      // Two guards that protect against catastrophic sync-gone-wrong scenarios.
      // Both require a non-trivially-populated manifest (>= 10 known files) so
      // fresh installs and first syncs are never affected.
      //
      // Guard 1 — Excess-deletes (rclone --max-delete equivalent):
      //   If > 50% of known local files would be deleted, abort.  Triggers on:
      //   wrong server URL, server data wipe, or accidental vault mismatch.
      //
      // Guard 2 — Everything-changed (rclone foundSame equivalent):
      //   If every known file appears modified simultaneously, something outside
      //   normal editing caused it (DST clock jump, vault folder moved/copied,
      //   filesystem remount with different mtime precision).  Abort so we don't
      //   upload or conflict-copy the entire vault at once.
      const manifestSize = this.manifestManager.getAllPaths().length;
      if (!this.isForceSyncing && manifestSize >= 10) {
        let pendingLocalDeletes = 0;
        let noopOrMinorCount = 0;

        for (const p of allPaths) {
          const lr = this.manifestManager.getRecord(p);
          const sr = serverManifest[p];
          const lf = this.plugin.app.vault.getAbstractFileByPath(p);
          const localExists = lf instanceof TFile || localPaths.has(p);

          // Count files that would be deleted locally
          if (lr && !sr && localExists && lr.hash) {
            pendingLocalDeletes++;
          }
          // Count files that appear unchanged (mtime + server hash match)
          if (lr && sr && lf instanceof TFile &&
              lf.stat.mtime === lr.localMtime && sr.hash === lr.hash) {
            noopOrMinorCount++;
          }
        }

        // Guard 1: excess deletes
        const deleteRatio = pendingLocalDeletes / manifestSize;
        if (deleteRatio > 0.5) {
          const msg =
            `VPS Sync: Aborted — sync would delete ${pendingLocalDeletes} local ` +
            `files (${Math.round(deleteRatio * 100)}% of known files). ` +
            `This looks wrong. Use Force Sync to override, or check your server.`;
          console.error(`[VPS Sync] ${msg}`);
          new Notice(msg, 0);
          return;
        }

        // Guard 2: everything-changed (foundSame = false)
        // Only fires when we have enough existing files on both sides to judge
        const bothSidesKnown = allPaths.filter(p =>
          this.manifestManager.getRecord(p) && serverManifest[p]
        ).length;
        if (bothSidesKnown >= 10 && noopOrMinorCount === 0) {
          const msg =
            `VPS Sync: Aborted — every known file appears changed simultaneously. ` +
            `This may indicate a clock jump, vault folder move, or wrong server. ` +
            `Use Force Sync to proceed anyway.`;
          console.error(`[VPS Sync] ${msg}`);
          new Notice(msg, 0);
          return;
        }
      }

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
            // rclone-style change detection (size → mtime → hash):
            //   1. If size differs from the server's known size, file definitely
            //      changed — read and hash immediately (no point checking mtime).
            //   2. If mtime unchanged since last sync, reuse stored hash (skip I/O).
            //   3. Otherwise read and compute a fresh hash.
            const sizeMatchesServer =
              serverRecord && localFile.stat.size === serverRecord.size;
            const mtimeUnchanged =
              localRecord && localFile.stat.mtime === localRecord.localMtime;

            if (mtimeUnchanged && (sizeMatchesServer || !serverRecord)) {
              // Fast path: mtime unchanged and size agrees with server (or file
              // is not on the server yet so size can't be compared).
              currentHash = localRecord!.hash;
              // localContent stays null; lazy-loaded below if push is needed
            } else {
              localContent = await this.plugin.app.vault.readBinary(localFile);
              currentHash  = await ManifestManager.computeHash(localContent);
            }
          } else if (localPaths.has(path)) {
            // File exists on disk but not yet indexed by Obsidian
            // (unusual extension, or mobile vault still scanning)
            localContent = await this.readFileBytes(path);
            if (localContent) currentHash = await ManifestManager.computeHash(localContent);
          }

          const decision = ConflictResolver.classify(localRecord, serverRecord, currentHash);

          console.log(`[VPS Sync] ${decision.padEnd(16)} ${path}`);

          switch (decision) {
            case 'push':
              // Lazy-load content if mtime skip was applied above
              if (localContent === null && localFile instanceof TFile) {
                localContent = await this.plugin.app.vault.readBinary(localFile);
              }
              if (localContent !== null) {
                await this.withRetry(path, () =>
                  this.pushFileContent(path, localContent!, localRecord?.serverMtime ?? 0)
                );
                pushed++;
              }
              break;

            case 'pull':
              await this.withRetry(path, () => this.pullFile(path));
              pulled++;
              break;

            case 'conflict': {
              // ── Attempt 3-way merge before creating conflict copy ──────────
              let mergeSucceeded = false;
              if (isMergeableFile(path) && localFile instanceof TFile) {
                const baseText = await this.baseStore.load(path);
                if (baseText !== null) {
                  // Ensure localContent is loaded
                  if (localContent === null) {
                    localContent = await this.plugin.app.vault.readBinary(localFile);
                  }
                  // Fetch server content for merging
                  try {
                    const response = await this.client.sendRequest<PullResponsePayload>(
                      'PULL_REQUEST', { path }, 30000
                    );
                    const serverContent  = FileEncoder.decode(response.content, response.encoding);
                    const localText      = new TextDecoder().decode(localContent);
                    const serverText     = new TextDecoder().decode(serverContent);
                    const result         = merge3(baseText, localText, serverText);

                    if (result !== null) {
                      const mergedBytes = new TextEncoder().encode(result.merged);
                      // Write merged content locally and push it back to server
                      await this.plugin.app.vault.modifyBinary(localFile, mergedBytes.buffer);
                      await this.withRetry(path, () =>
                        this.pushFileContent(path, mergedBytes.buffer, response.mtime)
                      );
                      await this.baseStore.save(path, result.merged);

                      if (result.conflicts > 0) {
                        this.conflictCount++;
                        new Notice(
                          `VPS Sync: Conflict in "${path}" — ` +
                          `${result.conflicts} region(s) need manual resolution.`
                        );
                      }
                      mergeSucceeded = true;
                    }
                  } catch (mergeErr) {
                    console.warn(`[VPS Sync] 3-way merge fetch failed for "${path}", falling back:`, mergeErr);
                  }
                }
              }

              if (!mergeSucceeded) {
                // Fallback: pull server version as a conflict copy, push local version
                const conflictPath = ConflictResolver.buildConflictPath(path);
                await this.withRetry(path, () => this.pullFileTo(path, conflictPath));
                if (localContent === null && localFile instanceof TFile) {
                  localContent = await this.plugin.app.vault.readBinary(localFile);
                }
                if (localContent !== null) {
                  await this.withRetry(path, () => this.pushFileContent(path, localContent!, 0));
                }
                this.conflictCount++;
                new Notice(`VPS Sync: Conflict on "${path}" — conflict copy created.`);
              }
              break;
            }

            case 'delete_local':
              await this.deleteLocalFile(path);
              break;

            case 'delete_remote':
              await this.withRetry(path, () =>
                this.client.sendRequest<FileAckPayload>('FILE_DELETE', { path }, 10000)
              );
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

      // Save base content so 3-way merge can use it if a conflict arises later
      if (isMergeableFile(path)) {
        const text = new TextDecoder().decode(content);
        await this.baseStore.save(path, text);
      }
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

      // Save base so 3-way merge can use it later (only when pulling to the canonical path)
      if (destPath === sourcePath && isMergeableFile(destPath)) {
        const text = new TextDecoder().decode(content);
        await this.baseStore.save(destPath, text);
      }
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

      // Decode incoming content once — reused in all branches below
      const incomingContent = FileEncoder.decode(payload.content, payload.encoding);
      const incomingHash    = await ManifestManager.computeHash(incomingContent);

      if (existing instanceof TFile) {
        const localContent = await this.plugin.app.vault.readBinary(existing);
        const localHash    = await ManifestManager.computeHash(localContent);

        // ── Hash-equal early exit ──────────────────────────────────────────
        // If our local file already has the exact same content as the incoming
        // change (e.g. server echoing back our own push, or two devices that
        // happen to make the same edit), just update serverMtime and skip the
        // write entirely.  This prevents:
        //   • Unnecessary modifyBinary → modify event → debounce → push round-trip
        //   • Spurious conflict copies when content is already identical
        if (localHash === incomingHash) {
          this.manifestManager.setRecord(payload.path, {
            hash: incomingHash,
            serverMtime: payload.mtime,
            localMtime: existing.stat.mtime,
          });
          await this.manifestManager.save();
          return;
        }

        // ── Real conflict: local has unsaved edits, server has different content ──
        // Strategy:
        //   1. If the file is text, attempt a 3-way merge using the last-synced base.
        //      • Clean merge (0 conflicts) → apply merged content silently. No copy needed.
        //      • Merge with conflict markers → write merged content (with markers) in-place
        //        so the user can resolve them directly in the file.
        //   2. For binary files, or when no base is available, fall back to the old
        //      behaviour: keep local edits in place and create a conflict copy of the
        //      remote version.
        //
        // In all branches, advance serverMtime FIRST to prevent the cascade-conflict bug.
        if (localRecord && localHash !== localRecord.hash) {
          // CRITICAL: advance serverMtime on the original path so the next push
          // from this device uses the updated baseline, preventing the server from
          // seeing serverRecord.mtime > payload.serverMtime and raising a second
          // conflict on what is really just a continuation of the user's edits.
          this.manifestManager.setRecord(payload.path, {
            hash: localRecord.hash,       // local content unchanged (for now)
            serverMtime: payload.mtime,   // ← advance to server's latest mtime
            localMtime: localRecord.localMtime,
          });

          // ── Attempt 3-way merge ──────────────────────────────────────────
          if (isMergeableFile(payload.path)) {
            const baseText = await this.baseStore.load(payload.path);
            if (baseText !== null) {
              const localText    = new TextDecoder().decode(localContent);
              const incomingText = new TextDecoder().decode(incomingContent);
              const result       = merge3(baseText, localText, incomingText);

              if (result !== null) {
                const mergedBytes = new TextEncoder().encode(result.merged);
                const mergedHash  = await ManifestManager.computeHash(mergedBytes.buffer);

                // Apply merged content in place
                await this.plugin.app.vault.modifyBinary(existing, mergedBytes.buffer);
                const updatedFile = this.plugin.app.vault.getAbstractFileByPath(payload.path);
                const newLocalMtime = updatedFile instanceof TFile ? updatedFile.stat.mtime : Date.now();

                this.manifestManager.setRecord(payload.path, {
                  hash: mergedHash,
                  serverMtime: payload.mtime,
                  localMtime: newLocalMtime,
                });

                // Save new merged content as the base for next conflict
                await this.baseStore.save(payload.path, result.merged);

                if (result.conflicts > 0) {
                  new Notice(
                    `VPS Sync: Conflict in "${payload.path}" — ` +
                    `${result.conflicts} region(s) need manual resolution.`
                  );
                  this.plugin.statusBar.showConflictBadge(result.conflicts);
                }
                // else: clean merge — no notice, no badge
                await this.manifestManager.save();
                return;
              }
            }
          }

          // ── Conflict copy fallback ───────────────────────────────────────
          // Conflict copy cooldown (rclone-inspired): during continuous active
          // editing, remote pushes arrive every few seconds.  Suppress duplicate
          // conflict copies for the same file within CONFLICT_COOLDOWN_MS so the
          // vault isn't flooded with near-identical copies.
          const now = Date.now();
          const lastConflict = this.lastConflictTime.get(payload.path) ?? 0;
          if (now - lastConflict < SyncManager.CONFLICT_COOLDOWN_MS) {
            // Already created a copy recently — serverMtime is already updated
            // above; just save and return without another copy.
            await this.manifestManager.save();
            return;
          }
          this.lastConflictTime.set(payload.path, now);

          const conflictPath = ConflictResolver.buildConflictPath(payload.path);
          await this.ensureParentFolders(conflictPath);
          await this.plugin.app.vault.createBinary(conflictPath, incomingContent);
          this.manifestManager.setRecord(conflictPath, {
            hash: incomingHash, serverMtime: payload.mtime, localMtime: now,
          });

          new Notice(`VPS Sync: Conflict on "${payload.path}" — conflict copy created.`);
          this.plugin.statusBar.showConflictBadge(1);
          await this.manifestManager.save();
          return;
        }
      }

      // ── Safe to apply remote change ────────────────────────────────────────
      if (existing instanceof TFile) {
        await this.plugin.app.vault.modifyBinary(existing, incomingContent);
      } else {
        await this.ensureParentFolders(payload.path);
        await this.plugin.app.vault.createBinary(payload.path, incomingContent);
      }

      const file = this.plugin.app.vault.getAbstractFileByPath(payload.path);
      const localMtime = file instanceof TFile ? file.stat.mtime : Date.now();
      this.manifestManager.setRecord(payload.path, {
        hash: incomingHash, serverMtime: payload.mtime, localMtime,
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

  /**
   * Retry helper (rclone-style exponential backoff).
   * Retries transient failures (network blips, server restarts) automatically.
   * Logs each attempt so the user can diagnose persistent issues.
   */
  private async withRetry<T>(
    path: string,
    fn: () => Promise<T>,
    maxRetries = 3
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (e) {
        lastError = e;
        if (attempt < maxRetries) {
          const delay = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
          console.warn(`[VPS Sync] Retry ${attempt + 1}/${maxRetries} for "${path}" in ${delay}ms:`, e);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    throw lastError;
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
