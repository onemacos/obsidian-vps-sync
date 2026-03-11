import { Notice } from 'obsidian';
import type {
  WsMessage,
  MessageType,
  FileUpsertPayload,
  FileDeletePayload,
  FileRenamePayload,
  ConflictNotifyPayload,
  FileAckPayload,
  PullResponsePayload,
  ConnectionStatus,
  VpsSyncSettings,
} from './types';

type EventMap = {
  statusChange: (status: ConnectionStatus) => void;
  authenticated: () => void;
  authFail: (msg: string) => void;
  remoteChange: (payload: FileUpsertPayload) => void;
  remoteDelete: (payload: FileDeletePayload) => void;
  remoteRename: (payload: FileRenamePayload) => void;
  conflictNotify: (payload: ConflictNotifyPayload) => void;
  error: (msg: string) => void;
};

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WsClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private readonly MAX_RECONNECT_DELAY = 30000;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private status: ConnectionStatus = 'disconnected';
  private destroying = false;

  private listeners: Partial<{ [K in keyof EventMap]: EventMap[K][] }> = {};
  private pendingRequests = new Map<string, PendingRequest>();

  constructor(private settings: VpsSyncSettings) {}

  // ── Event emitter ──────────────────────────────────────────────────────────

  on<K extends keyof EventMap>(event: K, handler: EventMap[K]): void {
    if (!this.listeners[event]) this.listeners[event] = [];
    (this.listeners[event] as EventMap[K][]).push(handler);
  }

  off<K extends keyof EventMap>(event: K, handler: EventMap[K]): void {
    if (!this.listeners[event]) return;
    this.listeners[event] = (this.listeners[event] as EventMap[K][]).filter(h => h !== handler) as typeof this.listeners[K];
  }

  private emit<K extends keyof EventMap>(event: K, ...args: Parameters<EventMap[K]>): void {
    (this.listeners[event] ?? []).forEach(h => (h as (...a: Parameters<EventMap[K]>) => void)(...args));
  }

  // ── Connection management ─────────────────────────────────────────────────

  connect(): void {
    if (this.destroying) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.setStatus('connecting');

    try {
      this.ws = new WebSocket(this.settings.serverUrl);
    } catch {
      this.setStatus('error');
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
      this.setStatus('authenticating');
      this.sendFireAndForget('AUTH', { apiKey: this.settings.apiKey });
      this.startPing();
    };

    this.ws.onmessage = (event: MessageEvent) => {
      this.handleMessage(event.data as string);
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror — handled there
    };

    this.ws.onclose = () => {
      this.stopPing();
      if (this.status !== 'error') {
        this.setStatus('disconnected');
      }
      if (!this.destroying) {
        this.scheduleReconnect();
      }
    };
  }

  disconnect(): void {
    this.destroying = true;
    this.stopPing();
    this.clearReconnect();
    this.rejectAllPending(new Error('Client disconnected'));
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.setStatus('disconnected');
  }

  // ── Sending ───────────────────────────────────────────────────────────────

  /** Send a message and wait for a matching ACK or response. */
  async sendRequest<T>(
    type: MessageType,
    payload: unknown,
    timeoutMs = 15000
  ): Promise<T> {
    const requestId = crypto.randomUUID();
    const msg: WsMessage = { type, requestId, payload };

    return new Promise<T>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Request ${type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });

      this.ws.send(JSON.stringify(msg));
    });
  }

  /** Fire-and-forget — no response expected. */
  sendFireAndForget(type: MessageType, payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const msg: WsMessage = { type, payload };
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      // Swallow — will reconnect
    }
  }

  isConnected(): boolean {
    return this.status === 'connected';
  }

  // ── Message routing ───────────────────────────────────────────────────────

  private handleMessage(raw: string): void {
    let msg: WsMessage;
    try {
      msg = JSON.parse(raw) as WsMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case 'AUTH_OK':
        this.setStatus('connected');
        this.emit('authenticated');
        break;

      case 'AUTH_FAIL':
        this.setStatus('error');
        this.emit('authFail', (msg.payload as { error?: string })?.error ?? 'Auth failed');
        this.disconnect();
        new Notice('VPS Sync: Authentication failed. Check your API key.');
        break;

      case 'FILE_UPSERT':
        this.emit('remoteChange', msg.payload as FileUpsertPayload);
        break;

      case 'FILE_DELETE':
        this.emit('remoteDelete', msg.payload as FileDeletePayload);
        break;

      case 'FILE_RENAME':
        this.emit('remoteRename', msg.payload as FileRenamePayload);
        break;

      case 'CONFLICT_NOTIFY':
        this.emit('conflictNotify', msg.payload as ConflictNotifyPayload);
        break;

      case 'FILE_ACK':
      case 'PULL_RESPONSE':
      case 'MANIFEST_RESPONSE': {
        const reqId = msg.requestId ?? (msg.payload as { requestId?: string })?.requestId;
        if (reqId) {
          const pending = this.pendingRequests.get(reqId);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingRequests.delete(reqId);
            pending.resolve(msg.payload);
          }
        }
        break;
      }

      case 'PING':
        this.sendFireAndForget('PONG', {});
        break;

      case 'ERROR':
        this.emit('error', (msg.payload as { message?: string })?.message ?? 'Server error');
        break;
    }
  }

  // ── Keep-alive ────────────────────────────────────────────────────────────

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.sendFireAndForget('PING', {});
    }, 30000);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // ── Reconnect ─────────────────────────────────────────────────────────────

  private scheduleReconnect(): void {
    this.clearReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.MAX_RECONNECT_DELAY);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit('statusChange', status);
  }

  private rejectAllPending(err: Error): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pendingRequests.clear();
  }
}
