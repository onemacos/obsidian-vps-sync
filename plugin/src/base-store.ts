/**
 * base-store.ts — persists the last-synced base content for each file.
 *
 * Used by the 3-way merge engine: when both sides have modified a file,
 * we diff each side against the common ancestor (base) to produce a clean
 * merge wherever possible, rather than always creating a conflict copy.
 *
 * Storage layout (inside the vault):
 *   .obsidian/plugins/vps-sync/bases/<relative-file-path>.base
 *
 * Only text files are stored here (binary files are excluded from merging).
 * The base is stored as raw UTF-8 text (no encoding).
 */

import type VpsSyncPlugin from './main';

export class BaseContentStore {
  private static readonly BASE_DIR = '.obsidian/plugins/vps-sync/bases';

  constructor(private plugin: VpsSyncPlugin) {}

  /** Persist base content after a successful push or pull. */
  async save(filePath: string, content: string): Promise<void> {
    const basePath = this.basePath(filePath);
    try {
      await this.ensureDir(basePath);
      await this.plugin.app.vault.adapter.write(basePath, content);
    } catch (e) {
      // Non-fatal — worst case is we fall back to conflict copy
      console.warn(`[VPS Sync] BaseStore: failed to save base for "${filePath}":`, e);
    }
  }

  /** Load previously stored base content, or null if not found. */
  async load(filePath: string): Promise<string | null> {
    const basePath = this.basePath(filePath);
    try {
      return await this.plugin.app.vault.adapter.read(basePath);
    } catch {
      return null;
    }
  }

  /** Remove the stored base (called after a file is deleted). */
  async delete(filePath: string): Promise<void> {
    const basePath = this.basePath(filePath);
    try {
      await this.plugin.app.vault.adapter.remove(basePath);
    } catch {
      // Already gone — ignore
    }
  }

  /** Rename the stored base when a file is renamed. */
  async rename(oldPath: string, newPath: string): Promise<void> {
    const oldBase = this.basePath(oldPath);
    const newBase = this.basePath(newPath);
    try {
      const content = await this.plugin.app.vault.adapter.read(oldBase);
      await this.ensureDir(newBase);
      await this.plugin.app.vault.adapter.write(newBase, content);
      await this.plugin.app.vault.adapter.remove(oldBase);
    } catch {
      // Best-effort; if old base doesn't exist nothing to do
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private basePath(filePath: string): string {
    return `${BaseContentStore.BASE_DIR}/${filePath}.base`;
  }

  private async ensureDir(basePath: string): Promise<void> {
    const dir = basePath.substring(0, basePath.lastIndexOf('/'));
    if (!dir) return;
    try {
      await this.plugin.app.vault.adapter.mkdir(dir);
    } catch {
      // Directory already exists — ignore
    }
  }
}
