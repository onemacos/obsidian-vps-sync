import path from 'path';
import type { FileManager } from './file-manager';

export class ConflictHandler {
  /**
   * Build a conflict copy filename.
   * "Folder/Note.md" → "Folder/Note (conflict 2026-03-11T14-32-00).md"
   */
  static buildConflictPath(originalPath: string, timestamp?: Date): string {
    const ts = (timestamp ?? new Date())
      .toISOString()
      .slice(0, 19)
      .replace(/:/g, '-');

    const ext = path.extname(originalPath);
    const base = originalPath.slice(0, -ext.length || undefined);
    return ext ? `${base} (conflict ${ts})${ext}` : `${originalPath} (conflict ${ts})`;
  }

  /**
   * Create a conflict copy:
   * - Existing server content → conflictPath
   * - incomingContent → originalPath
   * Returns the conflict path.
   */
  static async createConflictCopy(
    fileManager: FileManager,
    originalPath: string,
    incomingContent: Buffer
  ): Promise<string> {
    const conflictPath = ConflictHandler.buildConflictPath(originalPath);

    // Move existing file to conflict path
    try {
      const existing = await fileManager.readFile(originalPath);
      await fileManager.writeFile(conflictPath, existing.content);
    } catch {
      // If existing file can't be read, just write incoming to original
    }

    // Write incoming content to the original path
    await fileManager.writeFile(originalPath, incomingContent);

    return conflictPath;
  }
}
