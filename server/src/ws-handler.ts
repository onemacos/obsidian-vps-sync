import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';
import { validateWsAuth } from './auth';
import { ConflictHandler } from './conflict-handler';
import type { FileManager } from './file-manager';
import type { ServerManifestManager } from './manifest-manager';
import type {
  WsMessage,
  FileUpsertPayload,
  FileDeletePayload,
  FileRenamePayload,
  PullRequestPayload,
} from './types';

interface AuthenticatedSocket extends WebSocket {
  isAuthenticated?: boolean;
}

export class WsHandler {
  private authenticatedClients = new Set<AuthenticatedSocket>();
  private pingIntervals = new Map<AuthenticatedSocket, ReturnType<typeof setInterval>>();

  constructor(
    private wss: WebSocketServer,
    private fileManager: FileManager,
    private manifestManager: ServerManifestManager,
    private apiKey: string,
    private serverId: string   // unique UUID per server restart — clients use this to detect server changes
  ) {}

  initialize(): void {
    this.wss.on('connection', (ws: AuthenticatedSocket, req: IncomingMessage) => {
      console.log(`[VPS Sync] Client connected from ${req.socket.remoteAddress}`);
      ws.isAuthenticated = false;

      // Auth timeout — must authenticate within 10s
      const authTimeout = setTimeout(() => {
        if (!ws.isAuthenticated) {
          this.send(ws, { type: 'AUTH_FAIL', payload: { error: 'Authentication timeout' } });
          ws.close();
        }
      }, 10000);

      ws.on('message', (raw: Buffer) => {
        this.handleMessage(ws, raw.toString()).catch(err =>
          console.error('[VPS Sync] Message handler error', err)
        );
      });

      ws.on('close', () => {
        clearTimeout(authTimeout);
        this.stopPing(ws);
        this.authenticatedClients.delete(ws);
        console.log('[VPS Sync] Client disconnected');
      });

      ws.on('error', err => {
        console.error('[VPS Sync] WebSocket error', err.message);
      });
    });
  }

  // ── Message routing ───────────────────────────────────────────────────────

  private async handleMessage(ws: AuthenticatedSocket, raw: string): Promise<void> {
    let msg: WsMessage;
    try {
      msg = JSON.parse(raw) as WsMessage;
    } catch {
      this.sendError(ws, 'PARSE_ERROR', 'Invalid JSON');
      return;
    }

    // Only allow AUTH before authentication
    if (!ws.isAuthenticated && msg.type !== 'AUTH') {
      this.sendError(ws, 'NOT_AUTHENTICATED', 'Must authenticate first');
      return;
    }

    switch (msg.type) {
      case 'AUTH':
        this.handleAuth(ws, msg);
        break;
      case 'MANIFEST_REQUEST':
        await this.handleManifestRequest(ws, msg);
        break;
      case 'FILE_UPSERT':
        await this.handleFileUpsert(ws, msg);
        break;
      case 'FILE_DELETE':
        await this.handleFileDelete(ws, msg);
        break;
      case 'FILE_RENAME':
        await this.handleFileRename(ws, msg);
        break;
      case 'PULL_REQUEST':
        await this.handlePullRequest(ws, msg);
        break;
      case 'MANIFEST_REBUILD':
        await this.handleManifestRebuild(ws, msg);
        break;
      case 'PONG':
        // Keep-alive acknowledged
        break;
      default:
        this.sendError(ws, 'UNKNOWN_TYPE', `Unknown message type: ${msg.type}`);
    }
  }

  // ── Handlers ──────────────────────────────────────────────────────────────

  private handleAuth(ws: AuthenticatedSocket, msg: WsMessage): void {
    if (validateWsAuth(this.apiKey, msg)) {
      ws.isAuthenticated = true;
      this.authenticatedClients.add(ws);
      this.send(ws, { type: 'AUTH_OK', payload: {} });
      this.startPing(ws);
      console.log('[VPS Sync] Client authenticated');
    } else {
      this.send(ws, { type: 'AUTH_FAIL', payload: { error: 'Invalid API key' } });
      ws.close();
    }
  }

  private async handleManifestRequest(ws: AuthenticatedSocket, msg: WsMessage): Promise<void> {
    const manifest = this.manifestManager.getManifest();
    this.send(ws, {
      type: 'MANIFEST_RESPONSE',
      requestId: msg.requestId,
      payload: { manifest, serverId: this.serverId },
    });
  }

  private async handleManifestRebuild(ws: AuthenticatedSocket, msg: WsMessage): Promise<void> {
    try {
      console.log('[VPS Sync] MANIFEST_REBUILD requested by client');
      const count = await this.manifestManager.buildFromDisk(this.fileManager);
      this.send(ws, {
        type: 'MANIFEST_REBUILD_RESULT',
        requestId: msg.requestId,
        payload: { success: true, count },
      });
    } catch (e) {
      console.error('[VPS Sync] MANIFEST_REBUILD failed:', e);
      this.send(ws, {
        type: 'MANIFEST_REBUILD_RESULT',
        requestId: msg.requestId,
        payload: { success: false, error: String(e) },
      });
    }
  }

  private async handleFileUpsert(ws: AuthenticatedSocket, msg: WsMessage): Promise<void> {
    const payload = msg.payload as FileUpsertPayload;
    const relativePath = payload.path;

    // Validate path — throws on traversal attempt
    try {
      this.fileManager.sanitizePath(relativePath);
    } catch (e) {
      this.sendAck(ws, msg.requestId, false, String(e));
      return;
    }

    const content = this.decodeContent(payload.content, payload.encoding);
    const incomingHash = this.fileManager.computeHash(content);

    try {
      const serverRecord = this.manifestManager.getRecord(relativePath);

      let conflictPath: string | null = null;

      if (serverRecord) {
        if (serverRecord.hash === incomingHash) {
          // Idempotent — same content
          this.sendAck(ws, msg.requestId, true, undefined, serverRecord.mtime);
          return;
        }

        // Conflict check: server was modified after client's last sync point
        if (serverRecord.mtime > payload.serverMtime && payload.serverMtime > 0) {
          // Backup current server version before conflict resolution
          await this.fileManager.backupFile(relativePath);
          conflictPath = await ConflictHandler.createConflictCopy(
            this.fileManager,
            relativePath,
            content
          );

          // Update manifest for conflict copy
          const conflictFileResult = await this.fileManager.readFile(conflictPath).catch(() => null);
          if (conflictFileResult) {
            this.manifestManager.update(conflictPath, {
              hash: conflictFileResult.hash,
              mtime: conflictFileResult.mtime,
              size: conflictFileResult.size,
            });
          }

          // Notify originating client
          this.send(ws, {
            type: 'CONFLICT_NOTIFY',
            payload: { originalPath: relativePath, conflictPath },
          });

          // Broadcast conflict notify to others
          this.broadcast(ws, {
            type: 'CONFLICT_NOTIFY',
            payload: { originalPath: relativePath, conflictPath },
          });
        } else {
          // Safe overwrite — backup before replacing
          await this.fileManager.backupFile(relativePath);
          await this.fileManager.writeFile(relativePath, content);
        }
      } else {
        // New file — no backup needed
        await this.fileManager.writeFile(relativePath, content);
      }

      // Update manifest
      const written = await this.fileManager.readFile(relativePath);

      // Verify write integrity (rclone-style): detect silent corruption
      if (!conflictPath && written.hash !== incomingHash) {
        throw new Error(
          `Write integrity check failed for "${relativePath}": ` +
          `expected ${incomingHash}, got ${written.hash}`
        );
      }

      this.manifestManager.update(relativePath, {
        hash: written.hash,
        mtime: written.mtime,
        size: written.size,
      });

      // Send ACK
      this.sendAck(ws, msg.requestId, true, undefined, written.mtime);

      // Broadcast to other clients (if no conflict copy was already sent)
      if (!conflictPath) {
        this.broadcast(ws, {
          type: 'FILE_UPSERT',
          payload: {
            path: relativePath,
            content: payload.content,
            encoding: payload.encoding,
            hash: written.hash,
            mtime: written.mtime,
            serverMtime: written.mtime,
          },
        });
      }
    } catch (e) {
      console.error(`[VPS Sync] handleFileUpsert error for ${relativePath}`, e);
      this.sendAck(ws, msg.requestId, false, String(e));
    }
  }

  private async handleFileDelete(ws: AuthenticatedSocket, msg: WsMessage): Promise<void> {
    const payload = msg.payload as FileDeletePayload;
    try {
      this.fileManager.sanitizePath(payload.path); // validate
      await this.fileManager.deleteFile(payload.path);
      this.manifestManager.delete(payload.path);
      this.sendAck(ws, msg.requestId, true);
      this.broadcast(ws, { type: 'FILE_DELETE', payload: { path: payload.path } });
    } catch (e) {
      this.sendAck(ws, msg.requestId, false, String(e));
    }
  }

  private async handleFileRename(ws: AuthenticatedSocket, msg: WsMessage): Promise<void> {
    const payload = msg.payload as FileRenamePayload;
    try {
      this.fileManager.sanitizePath(payload.oldPath);
      this.fileManager.sanitizePath(payload.newPath);
      await this.fileManager.renameFile(payload.oldPath, payload.newPath);
      this.manifestManager.rename(payload.oldPath, payload.newPath);
      this.sendAck(ws, msg.requestId, true);
      this.broadcast(ws, {
        type: 'FILE_RENAME',
        payload: { oldPath: payload.oldPath, newPath: payload.newPath },
      });
    } catch (e) {
      this.sendAck(ws, msg.requestId, false, String(e));
    }
  }

  private async handlePullRequest(ws: AuthenticatedSocket, msg: WsMessage): Promise<void> {
    const payload = msg.payload as PullRequestPayload;
    // Always use the WS-level requestId so the client's sendRequest() can match it
    const reqId = msg.requestId;

    try {
      this.fileManager.sanitizePath(payload.path);
      const file = await this.fileManager.readFile(payload.path);

      const isText = isTextExtension(payload.path);
      const encoded = isText
        ? file.content.toString('utf-8')
        : file.content.toString('base64');
      const encoding: 'utf8' | 'base64' = isText ? 'utf8' : 'base64';

      this.send(ws, {
        type: 'PULL_RESPONSE',
        requestId: reqId,
        payload: {
          path: payload.path,
          content: encoded,
          encoding,
          hash: file.hash,
          mtime: file.mtime,
          serverMtime: file.mtime,
          requestId: reqId,
        },
      });
    } catch (e) {
      this.sendError(ws, 'PULL_ERROR', `Could not read ${payload.path}: ${e}`);
    }
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  private send(ws: AuthenticatedSocket, msg: Partial<WsMessage> & { type: string }): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  private broadcast(exclude: AuthenticatedSocket, msg: Partial<WsMessage> & { type: string }): void {
    for (const client of this.authenticatedClients) {
      if (client !== exclude && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(msg));
      }
    }
  }

  private sendAck(
    ws: AuthenticatedSocket,
    requestId: string | undefined,
    success: boolean,
    error?: string,
    mtime?: number
  ): void {
    this.send(ws, {
      type: 'FILE_ACK',
      requestId,
      payload: { requestId, success, mtime, error },
    });
  }

  private sendError(ws: AuthenticatedSocket, code: string, message: string): void {
    this.send(ws, { type: 'ERROR', payload: { code, message } });
  }

  private decodeContent(content: string, encoding: 'utf8' | 'base64'): Buffer {
    if (encoding === 'base64') return Buffer.from(content, 'base64');
    return Buffer.from(content, 'utf-8');
  }

  private startPing(ws: AuthenticatedSocket): void {
    const interval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        this.send(ws, { type: 'PING', payload: {} });
      } else {
        this.stopPing(ws);
      }
    }, 15000); // 15s — keeps Cloudflare tunnel alive (100s idle timeout)
    this.pingIntervals.set(ws, interval);
  }

  private stopPing(ws: AuthenticatedSocket): void {
    const interval = this.pingIntervals.get(ws);
    if (interval) {
      clearInterval(interval);
      this.pingIntervals.delete(ws);
    }
  }
}

const TEXT_EXTS = new Set([
  // Standard text formats
  '.md', '.txt', '.json', '.yaml', '.yml', '.csv', '.html', '.htm',
  '.xml', '.js', '.ts', '.jsx', '.tsx', '.css', '.scss', '.less',
  '.sh', '.bash', '.zsh', '.py', '.rb', '.go', '.rs', '.java', '.c',
  '.cpp', '.h', '.toml', '.ini', '.env', '.log', '.svg', '.mjs', '.cjs',
  // Obsidian-specific formats (must match plugin's file-encoder.ts)
  '.canvas', '.excalidraw', '.mdenc', '.enc', '.mdx', '.org', '.wiki',
]);

function isTextExtension(filePath: string): boolean {
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
  return TEXT_EXTS.has(ext);
}
