import type { ServerManifest, ServerFileRecord } from './types';
import type { FileManager } from './file-manager';

export class ServerManifestManager {
  private cache: ServerManifest = {};

  async buildFromDisk(fileManager: FileManager): Promise<void> {
    const files = await fileManager.listAllFiles();
    this.cache = {};
    for (const [path, record] of files) {
      this.cache[path] = record;
    }
    console.log(`[VPS Sync] Manifest built: ${Object.keys(this.cache).length} files`);
  }

  getManifest(): ServerManifest {
    return { ...this.cache };
  }

  getRecord(path: string): ServerFileRecord | undefined {
    return this.cache[path];
  }

  update(path: string, record: ServerFileRecord): void {
    this.cache[path] = record;
  }

  delete(path: string): void {
    delete this.cache[path];
  }

  rename(oldPath: string, newPath: string): void {
    const record = this.cache[oldPath];
    if (record) {
      delete this.cache[oldPath];
      this.cache[newPath] = record;
    }
  }
}
