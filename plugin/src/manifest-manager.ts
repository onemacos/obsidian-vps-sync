import type { Plugin } from 'obsidian';
import type { LocalManifest, FileRecord } from './types';

const MANIFEST_KEY = 'vps-sync-manifest';

export class ManifestManager {
  private manifest: LocalManifest = {};
  private plugin: Plugin | null = null;

  async load(plugin: Plugin): Promise<void> {
    this.plugin = plugin;
    const data = await plugin.loadData();
    this.manifest = (data?.[MANIFEST_KEY] as LocalManifest) ?? {};
  }

  async save(): Promise<void> {
    if (!this.plugin) return;
    const data = (await this.plugin.loadData()) ?? {};
    data[MANIFEST_KEY] = this.manifest;
    await this.plugin.saveData(data);
  }

  getRecord(path: string): FileRecord | undefined {
    return this.manifest[path];
  }

  setRecord(path: string, record: FileRecord): void {
    this.manifest[path] = record;
  }

  deleteRecord(path: string): void {
    delete this.manifest[path];
  }

  /** Wipe the entire in-memory manifest (used by Force Full Sync). */
  clearAll(): void {
    this.manifest = {};
  }

  getAllPaths(): string[] {
    return Object.keys(this.manifest);
  }

  getAll(): LocalManifest {
    return { ...this.manifest };
  }

  /**
   * Compute SHA-256 hash of file content.
   * Works in both Obsidian's Electron runtime and mobile (uses SubtleCrypto).
   */
  static async computeHash(content: ArrayBuffer | string): Promise<string> {
    let buffer: ArrayBuffer;
    if (typeof content === 'string') {
      buffer = new TextEncoder().encode(content).buffer;
    } else {
      buffer = content;
    }
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }
}
