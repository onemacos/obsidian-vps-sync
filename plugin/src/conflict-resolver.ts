import type { FileRecord, ServerFileRecord, SyncDecision } from './types';

export class ConflictResolver {
  /**
   * Build a conflict-copy filename.
   * "Folder/Note.md" → "Folder/Note (conflict 2026-03-11T14-32-00).md"
   */
  static buildConflictPath(originalPath: string, timestamp?: Date): string {
    const ts = (timestamp ?? new Date())
      .toISOString()
      .slice(0, 19)        // "2026-03-11T14:32:00"
      .replace(/:/g, '-'); // "2026-03-11T14-32-00"

    const lastDot = originalPath.lastIndexOf('.');
    const lastSlash = Math.max(originalPath.lastIndexOf('/'), originalPath.lastIndexOf('\\'));

    if (lastDot > lastSlash) {
      // Has extension
      const base = originalPath.slice(0, lastDot);
      const ext = originalPath.slice(lastDot);
      return `${base} (conflict ${ts})${ext}`;
    }
    // No extension
    return `${originalPath} (conflict ${ts})`;
  }

  /**
   * Determine the sync action for a file during startup comparison.
   *
   * @param localRecord   Entry in the local manifest (undefined = never synced)
   * @param serverRecord  Entry in the server manifest (undefined = not on server)
   * @param currentLocalHash  Current SHA-256 of the local file ("" = file deleted locally)
   */
  static classify(
    localRecord: FileRecord | undefined,
    serverRecord: ServerFileRecord | undefined,
    currentLocalHash: string
  ): SyncDecision {
    const localExists = currentLocalHash !== '';
    const serverExists = serverRecord !== undefined;
    const inManifest = localRecord !== undefined;

    // File never seen before on either side
    if (!inManifest) {
      if (localExists && !serverExists) return 'push';
      if (!localExists && serverExists) return 'pull';
      if (!localExists && !serverExists) return 'cleanup_manifest';
      // Both exist but never synced — compare content to decide
      // Same content: just record as synced, no transfer needed
      if (currentLocalHash === serverRecord!.hash) return 'noop';
      // Different content: keep both copies, don't silently overwrite either side
      return 'conflict';
    }

    // File was known, now deleted on server only
    if (inManifest && !serverExists && localExists) {
      // Server deleted it — if local unchanged respect the delete
      if (currentLocalHash === localRecord.hash) return 'delete_local';
      // Local was also modified — conflict: keep local
      return 'push';
    }

    // File was known, now deleted locally only
    if (inManifest && serverExists && !localExists) {
      // Local deleted it — if server unchanged respect the delete
      if (serverRecord.hash === localRecord.hash) return 'delete_remote';
      // Server was also modified — conflict: pull server version back
      return 'pull';
    }

    // Both gone
    if (!localExists && !serverExists) return 'cleanup_manifest';

    // Both exist — compare hashes
    const localChanged = currentLocalHash !== localRecord.hash;
    const serverChanged = serverRecord!.hash !== localRecord.hash;

    if (!localChanged && !serverChanged) return 'noop';
    if (localChanged && !serverChanged) return 'push';
    if (!localChanged && serverChanged) return 'pull';
    return 'conflict'; // both changed
  }
}
