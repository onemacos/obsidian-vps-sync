import fs from 'fs/promises';
import type { Dirent } from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { ServerFileRecord } from './types';

export interface BackupEntry {
  timestamp: string;   // ISO-like, e.g. "2026-03-11T14-32-00"
  size: number;
}

const MAX_BACKUPS_PER_FILE = 30;

export class FileManager {
  constructor(
    private vaultRoot: string,
    private backupRoot: string
  ) {}

  /**
   * Sanitize and validate a relative path to prevent directory traversal.
   * Throws if path escapes the vault root.
   */
  sanitizePath(input: string): string {
    // Strip leading slashes and normalize separators
    const cleaned = input.replace(/\\/g, '/').replace(/^\/+/, '');
    const resolved = path.resolve(this.vaultRoot, cleaned);
    if (!resolved.startsWith(path.resolve(this.vaultRoot) + path.sep) &&
        resolved !== path.resolve(this.vaultRoot)) {
      throw new Error(`Path traversal attempt blocked: ${input}`);
    }
    return resolved;
  }

  async readFile(relativePath: string): Promise<{ content: Buffer; mtime: number; size: number; hash: string }> {
    const absPath = this.sanitizePath(relativePath);
    const [content, stat] = await Promise.all([
      fs.readFile(absPath),
      fs.stat(absPath),
    ]);
    return {
      content,
      mtime: stat.mtimeMs,
      size: stat.size,
      hash: this.computeHash(content),
    };
  }

  async writeFile(relativePath: string, content: Buffer): Promise<{ mtime: number }> {
    const absPath = this.sanitizePath(relativePath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content);
    const stat = await fs.stat(absPath);
    return { mtime: stat.mtimeMs };
  }

  async deleteFile(relativePath: string): Promise<void> {
    const absPath = this.sanitizePath(relativePath);
    await fs.unlink(absPath).catch(() => {/* already gone */});
    // Clean up empty parent directories (best-effort)
    await this.removeEmptyDirs(path.dirname(absPath));
  }

  async renameFile(oldRelative: string, newRelative: string): Promise<void> {
    const oldAbs = this.sanitizePath(oldRelative);
    const newAbs = this.sanitizePath(newRelative);
    await fs.mkdir(path.dirname(newAbs), { recursive: true });
    await fs.rename(oldAbs, newAbs);
    await this.removeEmptyDirs(path.dirname(oldAbs));
  }

  async fileExists(relativePath: string): Promise<boolean> {
    try {
      const absPath = this.sanitizePath(relativePath);
      await fs.access(absPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Recursively walk vaultRoot and return all files as ServerFileRecord entries.
   */
  async listAllFiles(): Promise<Map<string, ServerFileRecord>> {
    const result = new Map<string, ServerFileRecord>();
    await this.walk(this.vaultRoot, this.vaultRoot, result);
    return result;
  }

  computeHash(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  // ── Backup methods ────────────────────────────────────────────────────────

  /**
   * Copy the current on-disk version of a file into the backup store.
   * Called before every overwrite so old versions are never lost.
   * Keeps the last MAX_BACKUPS_PER_FILE versions, deleting older ones.
   */
  async backupFile(relativePath: string): Promise<void> {
    const absPath = this.sanitizePath(relativePath);
    try {
      await fs.access(absPath);
    } catch {
      return; // File doesn't exist yet — nothing to backup
    }

    const ts = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const backupDir = path.join(this.backupRoot, relativePath);
    const backupFile = path.join(backupDir, `${ts}.bak`);

    await fs.mkdir(backupDir, { recursive: true });
    await fs.copyFile(absPath, backupFile);
    await this.pruneBackups(relativePath);
  }

  /** List all backup versions for a file, newest first. */
  async listBackups(relativePath: string): Promise<BackupEntry[]> {
    const backupDir = path.join(this.backupRoot, relativePath);
    try {
      const files = (await fs.readdir(backupDir))
        .filter(f => f.endsWith('.bak'))
        .sort()
        .reverse(); // newest first

      const entries: BackupEntry[] = [];
      for (const f of files) {
        const stat = await fs.stat(path.join(backupDir, f)).catch(() => null);
        if (stat) {
          entries.push({ timestamp: f.replace('.bak', ''), size: stat.size });
        }
      }
      return entries;
    } catch {
      return [];
    }
  }

  /** Restore a specific backup version, overwriting the current file. */
  async restoreBackup(relativePath: string, timestamp: string): Promise<{ mtime: number }> {
    // Validate timestamp format to prevent path traversal via this parameter
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(timestamp)) {
      throw new Error('Invalid timestamp format');
    }
    const backupFile = path.join(this.backupRoot, relativePath, `${timestamp}.bak`);
    const absPath = this.sanitizePath(relativePath);

    await fs.mkdir(path.dirname(absPath), { recursive: true });
    // Backup the current version before restoring
    await this.backupFile(relativePath);
    await fs.copyFile(backupFile, absPath);
    const stat = await fs.stat(absPath);
    return { mtime: stat.mtimeMs };
  }

  private async pruneBackups(relativePath: string): Promise<void> {
    const backupDir = path.join(this.backupRoot, relativePath);
    try {
      const files = (await fs.readdir(backupDir))
        .filter(f => f.endsWith('.bak'))
        .sort(); // oldest first

      if (files.length > MAX_BACKUPS_PER_FILE) {
        const toDelete = files.slice(0, files.length - MAX_BACKUPS_PER_FILE);
        for (const f of toDelete) {
          await fs.unlink(path.join(backupDir, f)).catch(() => {});
        }
      }
    } catch {
      // Backup dir may not exist yet — ignore
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async walk(
    dir: string,
    root: string,
    out: Map<string, ServerFileRecord>
  ): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      // Skip hidden system directories
      if (entry.name.startsWith('.git') || entry.name === 'node_modules') continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await this.walk(fullPath, root, out);
      } else if (entry.isFile()) {
        try {
          const [content, stat] = await Promise.all([
            fs.readFile(fullPath),
            fs.stat(fullPath),
          ]);
          const relativePath = path.relative(root, fullPath).replace(/\\/g, '/');
          out.set(relativePath, {
            hash: this.computeHash(content),
            mtime: stat.mtimeMs,
            size: stat.size,
          });
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  private async removeEmptyDirs(dir: string): Promise<void> {
    if (dir === this.vaultRoot || !dir.startsWith(this.vaultRoot)) return;
    try {
      const entries = await fs.readdir(dir);
      if (entries.length === 0) {
        await fs.rmdir(dir);
        await this.removeEmptyDirs(path.dirname(dir));
      }
    } catch {
      // Ignore
    }
  }
}
