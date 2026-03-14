// Server-side protocol types (mirrors plugin/src/types.ts)

export interface ServerFileRecord {
  hash: string;
  mtime: number;
  size: number;
}

export type ServerManifest = Record<string, ServerFileRecord>;

export type MessageType =
  | 'AUTH'
  | 'AUTH_OK'
  | 'AUTH_FAIL'
  | 'MANIFEST_REQUEST'
  | 'MANIFEST_RESPONSE'
  | 'MANIFEST_REBUILD'        // Client requests server to rebuild manifest from disk
  | 'MANIFEST_REBUILD_RESULT' // Server responds with rebuild result
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

export interface AuthPayload {
  apiKey: string;
}

export interface FileUpsertPayload {
  path: string;
  content: string;
  encoding: 'utf8' | 'base64';
  hash: string;
  mtime: number;
  serverMtime: number;
}

export interface FileDeletePayload {
  path: string;
}

export interface FileRenamePayload {
  oldPath: string;
  newPath: string;
}

export interface PullRequestPayload {
  path: string;
  requestId?: string;
}
