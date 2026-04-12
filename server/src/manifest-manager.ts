import fs from 'fs/promises';
import path from 'path';
import type { ServerManifest, ServerFileRecord } from './types';
import type { FileManager } from './file-manager';

/** How long tombstones are kept (90 days). Covers extended offline periods. */
const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export class ServerManifestManager {
  private cache: ServerManifest = {};
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param persistPath  Path to the JSON file used for manifest persistence,
   *                     e.g. /opt/vault-backups/manifest.json
   *                     The directory must be writable but MUST NOT be inside
   *                     the vault root (to avoid it appearing as a vault file).
   */
  constructor(private persistPath: string) {}

  // ── Persistence ─────────────────────────────────────────────────────────────

  /**
   * Load the persisted manifest from disk.
   * Returns true if successfully loaded, false if file missing or corrupt.
   */
  async load(): Promise<boolean> {
    try {
      const raw  = await fs.readFile(this.persistPath, 'utf-8');
      const data = JSON.parse(raw) as ServerManifest;
      if (typeof data !== 'object' || data === null) throw new Error('Not an object');
      this.cache = data;
      console.log(
        `[VPS Sync] Manifest loaded from ${this.persistPath}:`,
        `${Object.keys(this.cache).length} files`
      );
      return true;
    } catch (e) {
      // Normal on first run (file doesn't exist yet); also catches corrupt JSON
      console.log(`[VPS Sync] No persisted manifest at ${this.persistPath} — will build from vault`);
      return false;
    }
  }

  /** Write the current in-memory manifest to disk immediately. */
  async save(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.persistPath), { recursive: true });
      await fs.writeFile(this.persistPath, JSON.stringify(this.cache, null, 2), 'utf-8');
    } catch (e) {
      console.error('[VPS Sync] Failed to persist manifest to disk:', e);
    }
  }

  /** Schedule a save 2 s after the last mutation (debounced). */
  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save().catch(e => console.error('[VPS Sync] Manifest auto-save failed:', e));
    }, 2000);
  }

  // ── Build / rebuild ─────────────────────────────────────────────────────────

  /**
   * Rebuild the manifest by scanning the vault directory on disk.
   * Used at startup and via the MANIFEST_REBUILD WebSocket command.
   * Preserves existing tombstones so offline devices still receive deletion info.
   * Persists the result so it survives the next restart.
   */
  async buildFromDisk(fileManager: FileManager): Promise<number> {
    console.log('[VPS Sync] Building manifest from vault…');
    const files = await fileManager.listAllFiles();

    // Preserve existing tombstones before rebuilding
    const tombstones: ServerManifest = {};
    for (const [p, r] of Object.entries(this.cache)) {
      if (r.deleted) tombstones[p] = r;
    }

    this.cache = {};
    for (const [filePath, record] of files) {
      this.cache[filePath] = record;
    }

    // Re-add tombstones that are still within TTL (skip if file now exists again)
    const now = Date.now();
    for (const [p, r] of Object.entries(tombstones)) {
      if (!this.cache[p] && r.deletedAt && now - r.deletedAt < TOMBSTONE_TTL_MS) {
        this.cache[p] = r;
      }
    }

    const liveCount = Object.values(this.cache).filter(r => !r.deleted).length;
    const tombCount = Object.values(this.cache).filter(r => r.deleted).length;
    console.log(`[VPS Sync] Manifest built from vault: ${liveCount} files, ${tombCount} tombstones`);
    await this.save();
    return liveCount;
  }

  // ── Read ────────────────────────────────────────────────────────────────────

  /**
   * Return the full manifest including tombstones.
   * Clients use tombstone entries (deleted: true) to distinguish
   * "server deleted this file" from "server never had this file".
   */
  getManifest(): ServerManifest {
    this.pruneTombstones();
    return { ...this.cache };
  }

  getRecord(path: string): ServerFileRecord | undefined {
    const r = this.cache[path];
    if (r?.deleted) return undefined; // tombstones are not live records
    return r;
  }

  /** Get a record even if it's a tombstone. */
  getRaw(path: string): ServerFileRecord | undefined {
    return this.cache[path];
  }

  /** Is the given path a tombstone (recently deleted)? */
  isTombstone(path: string): boolean {
    const r = this.cache[path];
    return !!r?.deleted;
  }

  /** Number of live (non-deleted) entries. */
  size(): number {
    return Object.values(this.cache).filter(r => !r.deleted).length;
  }

  // ── Write (auto-persist after each mutation) ────────────────────────────────

  update(filePath: string, record: ServerFileRecord): void {
    // If this path was a tombstone, resurrect it (file re-created)
    this.cache[filePath] = { ...record, deleted: undefined, deletedAt: undefined };
    this.scheduleSave();
  }

  /**
   * Mark a file as deleted (tombstone) instead of erasing it.
   * Tombstones survive for TOMBSTONE_TTL_MS (90 days) so offline
   * devices learn about the deletion when they reconnect.
   */
  delete(filePath: string): void {
    const existing = this.cache[filePath];
    this.cache[filePath] = {
      hash: existing?.hash ?? '',
      mtime: existing?.mtime ?? Date.now(),
      size: 0,
      deleted: true,
      deletedAt: Date.now(),
    };
    this.scheduleSave();
  }

  rename(oldPath: string, newPath: string): void {
    const record = this.cache[oldPath];
    if (record && !record.deleted) {
      // Tombstone the old path so offline devices learn the rename
      this.cache[oldPath] = {
        hash: record.hash,
        mtime: record.mtime,
        size: 0,
        deleted: true,
        deletedAt: Date.now(),
      };
      this.cache[newPath] = record;
    }
    this.scheduleSave();
  }

  /** Remove tombstones older than TOMBSTONE_TTL_MS. */
  private pruneTombstones(): void {
    const now = Date.now();
    let pruned = 0;
    for (const [p, r] of Object.entries(this.cache)) {
      if (r.deleted && r.deletedAt && now - r.deletedAt > TOMBSTONE_TTL_MS) {
        delete this.cache[p];
        pruned++;
      }
    }
    if (pruned > 0) {
      console.log(`[VPS Sync] Pruned ${pruned} expired tombstones`);
      this.scheduleSave();
    }
  }
}
