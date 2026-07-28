import { sql } from 'drizzle-orm';
import { db } from '../database/db';
import { serverEvents } from '../database/schema';

export type ServerEventType = 'boot' | 'shutdown' | 'woke' | 'went-idle';

// How long after the last inbound Battlesnake request (/start, /move) the
// server is still considered "active by game traffic". Bot-only games send no
// WebSocket traffic, so without this window they'd never show as active.
const GAME_ACTIVE_WINDOW_MS = 60 * 1000;
// How long after the last real user-intent message (state-mutating actions
// like select-snake / select-move, or the activity heartbeat that only fires
// when the user genuinely interacted) the server counts as "active by user".
// Merely opening a page / holding a WebSocket open does NOT count — a passive
// open tab is exactly the "up but idle" waste band the timeline audits.
// 3 minutes comfortably covers the 2-minute activity-heartbeat cadence so an
// actively-interacting user doesn't flap between active and idle.
const USER_ACTIVE_WINDOW_MS = 3 * 60 * 1000;
// Cadence for the decay check that notices the game-traffic window expiring.
// Unref'd so it never keeps the process alive on its own.
const DECAY_CHECK_INTERVAL_MS = 15 * 1000;

/**
 * Records server lifecycle/activity events (boot, shutdown, woke, went-idle)
 * into the server_events table for the /activity autoscale audit page.
 *
 * Activity model: the server is "active" while a real user-intent message
 * (state-mutating action) arrived within USER_ACTIVE_WINDOW_MS OR a
 * Battlesnake game request arrived within GAME_ACTIVE_WINDOW_MS. Open
 * WebSocket connections alone do NOT count — passively open pages are "up
 * but idle". Transitions emit exactly one woke / went-idle event each.
 *
 * All writes are fire-and-forget (non-blocking): a failed insert is logged and
 * dropped — event logging must never slow down /move or block shutdown.
 */
export class ServerEventLogger {
  private static instance: ServerEventLogger;

  private wsConnections = 0;
  private lastUserIntentAt = 0;
  private lastGameRequestAt = 0;
  private lastGameRequestGameId: string | null = null;
  private active = false;
  private decayInterval: NodeJS.Timeout | null = null;
  // Chain of pending writes so shutdown() can flush what's in flight.
  private pendingWrites: Promise<void> = Promise.resolve();
  private shuttingDown = false;

  private constructor() {}

  public static getInstance(): ServerEventLogger {
    if (!ServerEventLogger.instance) {
      ServerEventLogger.instance = new ServerEventLogger();
    }
    return ServerEventLogger.instance;
  }

  /** Insert a boot event and start the game-traffic decay checker. */
  public recordBoot(detail?: Record<string, unknown>): void {
    this.write('boot', detail ?? null);
    if (!this.decayInterval) {
      this.decayInterval = setInterval(() => this.checkDecay(), DECAY_CHECK_INTERVAL_MS);
      if (typeof this.decayInterval.unref === 'function') this.decayInterval.unref();
    }
  }

  /**
   * Write a shutdown event and wait briefly for all pending writes to land.
   * Bounded by `timeoutMs` so an unreachable database can never block exit.
   */
  public async recordShutdownAndFlush(signal: string, timeoutMs = 2000): Promise<void> {
    this.shuttingDown = true;
    if (this.decayInterval) {
      clearInterval(this.decayInterval);
      this.decayInterval = null;
    }
    this.write('shutdown', { signal, connections: this.wsConnections });
    await Promise.race([
      this.pendingWrites,
      new Promise<void>(resolve => {
        const t = setTimeout(resolve, timeoutMs);
        if (typeof t.unref === 'function') t.unref();
      }),
    ]);
  }

  /** Called by the WebSocket server whenever the live connection count
   *  changes. Connection count alone does NOT make the server "active" —
   *  it is tracked only for event detail; activity requires user intent
   *  or game traffic. */
  public setConnectionCount(count: number): void {
    this.wsConnections = Math.max(0, count);
    this.evaluate('websocket');
  }

  /** Called when a real user-intent (state-mutating) WebSocket message
   *  arrives. This — not mere connections — is what marks the server active. */
  public recordUserIntent(): void {
    this.lastUserIntentAt = Date.now();
    this.evaluate('user-intent');
  }

  /** Called on inbound Battlesnake requests (/start, /move) so bot-only games
   *  count as activity even with zero WebSocket viewers. */
  public recordGameActivity(gameId: string | null): void {
    this.lastGameRequestAt = Date.now();
    this.lastGameRequestGameId = gameId;
    this.evaluate('game-request');
  }

  private isActiveNow(): boolean {
    const now = Date.now();
    return (
      now - this.lastUserIntentAt < USER_ACTIVE_WINDOW_MS ||
      now - this.lastGameRequestAt < GAME_ACTIVE_WINDOW_MS
    );
  }

  private checkDecay(): void {
    // Only transition can be active → idle here (nothing raises activity).
    this.evaluate('decay');
  }

  private evaluate(trigger: string): void {
    if (this.shuttingDown) return;
    const nowActive = this.isActiveNow();
    if (nowActive === this.active) return;
    this.active = nowActive;
    if (nowActive) {
      this.write('woke', {
        trigger,
        connections: this.wsConnections,
        gameId: trigger === 'game-request' ? this.lastGameRequestGameId : undefined,
      });
    } else {
      this.write('went-idle', { trigger, connections: this.wsConnections });
    }
  }

  private write(eventType: ServerEventType, detail: Record<string, unknown> | null): void {
    const cleanDetail =
      detail == null
        ? null
        : Object.fromEntries(Object.entries(detail).filter(([, v]) => v !== undefined));
    const p = db
      .insert(serverEvents)
      .values({
        eventType,
        detail: cleanDetail == null ? null : sql`${JSON.stringify(cleanDetail)}::jsonb`,
      })
      .then(() => undefined)
      .catch((err: unknown) => {
        console.error(`[ServerEventLogger] Failed to write ${eventType} event:`, (err as Error)?.message || err);
      });
    this.pendingWrites = this.pendingWrites.then(() => p);
  }
}
