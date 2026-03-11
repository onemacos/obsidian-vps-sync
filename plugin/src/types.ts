// ─────────────────────────────────────────────────────────────────────────────
// Shared types for the VPS Sync plugin ↔ server WebSocket protocol
// ─────────────────────────────────────────────────────────────────────────────

// ---------------------------------------------------------------------------
// Manifest / file tracking
// ---------------------------------------------------------------------------

/** Client-side record of a file's last-known sync state */
export interface FileRecord {
  /** SHA-256 hex of the file content at last successful sync */
  hash: string;
  /** Server-reported mtime (ms epoch) at last successful sync */
  serverMtime: number;
  /** Local filesystem mtime (ms epoch) at last successful sync */
  localMtime: number;
}

/** Full local manifest keyed by vault-relative path */
export type LocalManifest = Record<string, FileRecord>;

/** Server-side record for a single file */
export interface ServerFileRecord {
  hash: string;
  mtime: number;
  size: number;
}

/** Full server manifest keyed by vault-relative path */
export type ServerManifest = Record<string, ServerFileRecord>;

// ---------------------------------------------------------------------------
// Plugin settings
// ---------------------------------------------------------------------------

export interface VpsSyncSettings {
  serverUrl: string;          // e.g. wss://myserver.com:3241
  apiKey: string;
  syncEnabled: boolean;
  excludePatterns: string[];  // minimatch glob patterns to skip
}

export const DEFAULT_SETTINGS: VpsSyncSettings = {
  serverUrl: 'wss://yourserver.com:3241',
  apiKey: '',
  syncEnabled: true,
  excludePatterns: ['.obsidian/**', '.trash/**', '*.tmp', '.DS_Store'],
};

// ---------------------------------------------------------------------------
// WebSocket message protocol
// ---------------------------------------------------------------------------

export type MessageType =
  | 'AUTH'
  | 'AUTH_OK'
  | 'AUTH_FAIL'
  | 'MANIFEST_REQUEST'
  | 'MANIFEST_RESPONSE'
  | 'FILE_UPSERT'
  | 'FILE_DELETE'
  | 'FILE_RENAME'
  | 'FILE_ACK'
  | 'CONFLICT_NOTIFY'
  | 'PULL_REQUEST'
  | 'PULL_RESPONSE'
  | 'ERROR'
  | 'PING'
  | 'PONG';

export interface WsMessage {
  type: MessageType;
  requestId?: string;
  payload: unknown;
}

// ---------------------------------------------------------------------------
// Payload shapes
// ---------------------------------------------------------------------------

export interface AuthPayload {
  apiKey: string;
}

export interface ManifestResponsePayload {
  manifest: ServerManifest;
}

export interface FileUpsertPayload {
  path: string;
  /** UTF-8 text or base64-encoded binary */
  content: string;
  encoding: 'utf8' | 'base64';
  hash: string;
  mtime: number;
  /** Server mtime at last sync (for conflict detection). 0 if file is new. */
  serverMtime: number;
}

export interface FileDeletePayload {
  path: string;
}

export interface FileRenamePayload {
  oldPath: string;
  newPath: string;
}

export interface FileAckPayload {
  requestId: string;
  success: boolean;
  /** Server mtime after writing the file */
  mtime?: number;
  error?: string;
}

export interface ConflictNotifyPayload {
  originalPath: string;
  conflictPath: string;
}

export interface PullRequestPayload {
  path: string;
}

export interface PullResponsePayload extends FileUpsertPayload {
  requestId: string;
}

export interface ErrorPayload {
  code: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Sync decision types (used during startup sync comparison)
// ---------------------------------------------------------------------------

export type SyncDecision =
  | 'push'
  | 'pull'
  | 'conflict'
  | 'noop'
  | 'delete_local'
  | 'delete_remote'
  | 'cleanup_manifest';

export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'authenticating'
  | 'connected'
  | 'error';
