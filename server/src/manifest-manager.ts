import fs from 'fs/promises';
import path from 'path';
import type { ServerManifest, ServerFileRecord } from './types';
import type { FileManager } from './file-manager';

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
   * Persists the result so it survives the next restart.
   */
  async buildFromDisk(fileManager: FileManager): Promise<number> {
    console.log('[VPS Sync] Building manifest from vault…');
    const files = await fileManager.listAllFiles();
    this.cache  = {};
    for (const [filePath, record] of files) {
      this.cache[filePath] = record;
    }
    const count = Object.keys(this.cache).length;
    console.log(`[VPS Sync] Manifest built from vault: ${count} files`);
    // Persist immediately so the next restart can use it
    await this.save();
    return count;
  }

  // ── Read ────────────────────────────────────────────────────────────────────

  getManifest(): ServerManifest {
    return { ...this.cache };
  }

  getRecord(path: string): ServerFileRecord | undefined {
    return this.cache[path];
  }

  /** Number of entries currently tracked. */
  size(): number {
    return Object.keys(this.cache).length;
  }

  // ── Write (auto-persist after each mutation) ────────────────────────────────

  update(filePath: string, record: ServerFileRecord): void {
    this.cache[filePath] = record;
    this.scheduleSave();
  }

  delete(filePath: string): void {
    delete this.cache[filePath];
    this.scheduleSave();
  }

  rename(oldPath: string, newPath: string): void {
    const record = this.cache[oldPath];
    if (record) {
      delete this.cache[oldPath];
      this.cache[newPath] = record;
    }
    this.scheduleSave();
  }
}
