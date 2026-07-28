import * as fs from 'fs';
import * as path from 'path';

export type ConnectionEventType =
  | 'server-connect'
  | 'server-subscribe'
  | 'server-disconnect'
  | 'server-error'
  | 'server-idle-close'
  | 'server-backpressure-drop'
  | 'server-backpressure-terminate'
  | 'server-keepalive-terminate'
  | 'client-open'
  | 'client-close'
  | 'client-error'
  | 'client-reconnect-attempt'
  | 'client-idle-close'
  | 'client-page-hidden'
  | 'client-page-visible'
  | 'client-page-unload';

export interface ConnectionEvent {
  ts: number;
  type: ConnectionEventType;
  side: 'server' | 'client';
  connId?: string;
  /** Server-assigned WS connection id, if known. Set by the server for server-side
   *  events and echoed by the client (via the `debug-hello` handshake) for client
   *  events. Lets us correlate the two sides without trusting client-supplied data. */
  serverConnId?: string;
  gameId?: string;
  userId?: string;
  ip?: string;
  userAgent?: string;
  code?: number;
  reason?: string;
  message?: string;
  durationMs?: number;
  details?: Record<string, unknown>;
}

const LOG_DIR = 'connection-logs';
const LOG_FILE = 'ws-connections.log';
const RING_BUFFER_SIZE = 1000;

export class ConnectionLogger {
  private static instance: ConnectionLogger | null = null;
  private logFilePath: string;
  private writeStream: fs.WriteStream;
  private recentEvents: ConnectionEvent[] = [];
  private nextConnId = 1;
  private counters = {
    serverConnects: 0,
    serverDisconnects: 0,
    serverErrors: 0,
    clientOpens: 0,
    clientCloses: 0,
    clientErrors: 0,
  };
  private activeServerConnections = new Set<string>();

  private constructor() {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
    this.logFilePath = path.join(LOG_DIR, LOG_FILE);
    this.writeStream = fs.createWriteStream(this.logFilePath, { flags: 'a' });
  }

  static getInstance(): ConnectionLogger {
    if (!ConnectionLogger.instance) {
      ConnectionLogger.instance = new ConnectionLogger();
    }
    return ConnectionLogger.instance;
  }

  newConnId(): string {
    const id = `c${this.nextConnId++}-${Date.now().toString(36)}`;
    return id;
  }

  log(event: ConnectionEvent): void {
    if (!event.ts) event.ts = Date.now();

    switch (event.type) {
      case 'server-connect':
        this.counters.serverConnects++;
        if (event.connId) this.activeServerConnections.add(event.connId);
        break;
      case 'server-disconnect':
        this.counters.serverDisconnects++;
        if (event.connId) this.activeServerConnections.delete(event.connId);
        break;
      case 'server-error':
        this.counters.serverErrors++;
        // ws emits 'error' before 'close' for transport errors, but if the close
        // never fires (e.g. process death) the active set would otherwise drift.
        // Removal is idempotent so it's safe to do here too.
        if (event.connId) this.activeServerConnections.delete(event.connId);
        break;
      case 'client-open':
        this.counters.clientOpens++;
        break;
      case 'client-close':
        this.counters.clientCloses++;
        break;
      case 'client-error':
        this.counters.clientErrors++;
        break;
    }

    this.recentEvents.push(event);
    if (this.recentEvents.length > RING_BUFFER_SIZE) {
      this.recentEvents.splice(0, this.recentEvents.length - RING_BUFFER_SIZE);
    }

    try {
      this.writeStream.write(JSON.stringify(event) + '\n');
    } catch (err) {
      console.error('[ConnectionLogger] write failed:', err);
    }

    const human =
      `[WS ${event.side}] ${event.type}` +
      (event.connId ? ` conn=${event.connId}` : '') +
      (event.serverConnId && event.serverConnId !== event.connId ? ` srv=${event.serverConnId}` : '') +
      (event.userId ? ` user=${event.userId}` : '') +
      (event.gameId ? ` game=${event.gameId}` : '') +
      (event.code !== undefined ? ` code=${event.code}` : '') +
      (event.reason ? ` reason="${event.reason}"` : '') +
      (event.durationMs !== undefined ? ` dur=${event.durationMs}ms` : '') +
      (event.message ? ` msg="${event.message}"` : '');
    console.log(human);
  }

  getRecent(limit = 200): ConnectionEvent[] {
    if (limit >= this.recentEvents.length) return [...this.recentEvents];
    return this.recentEvents.slice(this.recentEvents.length - limit);
  }

  getStats() {
    return {
      ...this.counters,
      activeServerConnections: this.activeServerConnections.size,
      bufferedEvents: this.recentEvents.length,
      logFilePath: this.logFilePath,
    };
  }

  getLogFilePath(): string {
    return this.logFilePath;
  }

  shutdown(): Promise<void> {
    return new Promise((resolve) => {
      this.writeStream.end(() => resolve());
    });
  }
}
