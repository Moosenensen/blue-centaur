import { Server as HTTPServer, IncomingMessage } from 'http';
import { createHash } from 'crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { ActiveGameManager, TurnData } from './active-game-manager';
import { Direction } from '../types/battlesnake';
import { ConnectionLogger } from '../utils/connection-logger';
import { ConfigStore } from './configStore';
import { DEFAULT_CONFIG } from '../config/game-config';
import { ServerEventLogger } from '../logic/server-event-logger';
import {
  IDLE_CLOSE_CODE,
  IDLE_CLOSE_REASON,
  SERVER_IDLE_SWEEP_INTERVAL_MS,
  WS_KEEPALIVE_INTERVAL_MS,
} from '../shared/idle-policy';

interface WSClient {
  ws: WebSocket;
  gameId: string;
  userId: string;
  isLobby: boolean;
  connId: string;
  ip: string;
  userAgent: string;
  connectedAt: number;
  lastActivityAt: number;
  // Liveness flag for the keepalive ping/pong loop. Set true on every pong (and
  // on any inbound frame); the keepalive sweep sets it false right before
  // pinging, so a socket that misses a full interval's pong is treated as dead
  // and terminated. NOTE: this is connection liveness, NOT user activity — it
  // must never bump lastActivityAt or the 30-minute idle sweep would never fire.
  isAlive: boolean;
}

/** Inbound message types that represent real user intent. Pings (which the
 *  client sends every 5s for latency measurement) deliberately do NOT count
 *  — otherwise the idle sweep would never fire. The dedicated `activity`
 *  heartbeat from IdleWatcher is what keeps an active human "alive". */
const USER_INTENT_TYPES = new Set([
  'select-snake',
  'deselect',
  'hold-snake',
  'release-all-holds',
  'suicide-all',
  'select-move',
  'confirm-fatal-move',
  'set-premove',
  'set-nickname',
  'activity',
]);

interface WSMessage {
  type: string;
  [key: string]: any;
}

export class GameWebSocketServer {
  private wss: WebSocketServer;
  private clients: Set<WSClient> = new Set();
  private gameManager: ActiveGameManager;
  private connLogger: ConnectionLogger;
  private idleSweepInterval: NodeJS.Timeout | null = null;
  private keepaliveInterval: NodeJS.Timeout | null = null;
  // Last REAL user activity per userId, persisted across reconnects. Without
  // this, every proxy-drop → auto-reconnect cycle produced a brand-new client
  // whose lastActivityAt reset to "now" (and `subscribe-game` counted as
  // intent), so no connection ever looked idle to the sweep and an abandoned
  // tab kept the autoscale deployment alive indefinitely.
  private userActivity: Map<string, number> = new Map();
  private configStore: ConfigStore = new ConfigStore();
  // Current idle timeout in ms. Refreshed from the config store at the start
  // of every sweep tick, so changing `idleTimeoutMinutes` on the /config page
  // takes effect within one sweep interval (~1 minute) without a redeploy.
  private idleTimeoutMs: number = DEFAULT_CONFIG.idleTimeoutMinutes * 60 * 1000;

  constructor(server: HTTPServer) {
    this.gameManager = ActiveGameManager.getInstance();
    this.connLogger = ConnectionLogger.getInstance();

    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.startIdleSweep();
    this.startKeepalive();

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const ip =
        (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
        req.socket.remoteAddress ||
        'unknown';
      const userAgent = (req.headers['user-agent'] as string) || 'unknown';
      const connId = this.connLogger.newConnId();

      const now = Date.now();
      const client: WSClient = {
        ws,
        gameId: '',
        userId: '',
        isLobby: false,
        connId,
        ip,
        userAgent,
        connectedAt: now,
        lastActivityAt: now,
        isAlive: true,
      };
      this.clients.add(client);
      this.logActiveConnections('connect', connId);

      this.connLogger.log({
        ts: Date.now(),
        side: 'server',
        type: 'server-connect',
        connId,
        ip,
        userAgent,
      });

      // Hand the server-assigned conn id to the client so it can be echoed back
      // on debug POSTs. Lets us correlate server/client timelines deterministically.
      this.send(ws, { type: 'debug-hello', connId });

      ws.on('message', (data: Buffer) => {
        try {
          // Any inbound frame proves the socket is alive for the keepalive loop.
          // This is liveness only — it must NOT touch lastActivityAt unless the
          // message is genuine user intent (handled below).
          client.isAlive = true;
          const msg: WSMessage = JSON.parse(data.toString());
          if (msg && typeof msg.type === 'string' && USER_INTENT_TYPES.has(msg.type)) {
            client.lastActivityAt = Date.now();
            if (client.userId) {
              this.userActivity.set(client.userId, client.lastActivityAt);
            }
            // Real state-mutating intent — this (not mere connections or
            // presence heartbeats) marks the server "active" on the
            // /activity timeline. The 'activity' heartbeat fires on any
            // gesture (mouse move, tab focus) and only feeds the idle
            // clock above, never the activity timeline.
            if (msg.type !== 'activity') {
              ServerEventLogger.getInstance().recordUserIntent();
            }
          }
          this.handleMessage(client, msg);
        } catch (e) {
          console.error('WebSocket message parse error:', e);
        }
      });

      // Protocol-level pong replies keep the socket marked alive for the
      // keepalive sweep. Like inbound messages, this is liveness only and must
      // never bump lastActivityAt.
      ws.on('pong', () => {
        client.isAlive = true;
      });

      ws.on('close', (code: number, reasonBuf: Buffer) => {
        const reason = reasonBuf?.toString() || '';
        this.connLogger.log({
          ts: Date.now(),
          side: 'server',
          type: 'server-disconnect',
          connId: client.connId,
          gameId: client.gameId || undefined,
          userId: client.userId || undefined,
          ip: client.ip,
          code,
          reason,
          durationMs: Date.now() - client.connectedAt,
        });
        this.handleDisconnect(client);
        if (this.clients.delete(client)) {
          this.logActiveConnections('disconnect', client.connId);
        }
      });

      ws.on('error', (err) => {
        console.error('WebSocket error:', err);
        this.connLogger.log({
          ts: Date.now(),
          side: 'server',
          type: 'server-error',
          connId: client.connId,
          gameId: client.gameId || undefined,
          userId: client.userId || undefined,
          ip: client.ip,
          message: (err as Error)?.message || String(err),
        });
        this.handleDisconnect(client);
        if (this.clients.delete(client)) {
          this.logActiveConnections('error', client.connId);
        }
      });
    });

    this.gameManager.onBoardUpdate((gameId, gameState) => {
      const game = this.gameManager.getGame(gameId);

      this.broadcastToGame(gameId, {
        type: 'board-update',
        gameId,
        turn: gameState.turn,
        gameState: gameState,
        turnExpiryTime: game?.turnExpiryTime || null,
        measuredPing: this.gameManager.getMeasuredPing(),
        commitBufferMs: this.gameManager.getCommitBuffer(gameId),
        effectiveCommitBufferMs: this.gameManager.getEffectiveCommitBuffer(gameId),
        selections: this.getSelectionsForGame(gameId),
        holds: this.gameManager.getHoldStates(gameId),
        stagedMoves: this.getStagedMovesForGame(gameId),
        premoves: this.gameManager.getPremovesForGame(gameId),
        waypoints: this.gameManager.getWaypointsForGame(gameId),
        routes: this.gameManager.getRoutesForGame(gameId),
        activeIntentModes: this.gameManager.getActiveIntentModesForGame(gameId),
      });

      this.broadcastLobbyUpdate();
    });

    this.gameManager.onTurnUpdate((gameId, snakeId, turnData) => {
      const game = this.gameManager.getGame(gameId);

      this.broadcastToGame(gameId, {
        type: 'snake-turn-update',
        gameId,
        snakeId,
        turn: turnData.gameState.turn,
        moveEvaluations: turnData.moveEvaluations,
        territoryCells: turnData.territoryCells,
        safeMoves: turnData.safeMoves,
        botRecommendation: turnData.botRecommendation,
        timeout: turnData.gameState.game.timeout || 500,
        timestamp: turnData.timestamp,
        moveCommitted: game?.controlledSnakes.get(snakeId)?.moveCommittedThisTurn || false,
        committedMove: game?.controlledSnakes.get(snakeId)?.committedMove || null,
        // Carry the full staged-move map so each snake's grey (bot) arrow
        // appears/refreshes as soon as its own /move arrives — board-update only
        // fires for the snake that advanced the turn, leaving the others'
        // arrows missing until this per-snake update fills them in.
        stagedMoves: this.getStagedMovesForGame(gameId),
        routes: this.gameManager.getRoutesForGame(gameId),
        activeIntentModes: this.gameManager.getActiveIntentModesForGame(gameId),
      });
    });

    this.gameManager.onMoveCommitted((gameId, snakeId, move, source) => {
      this.broadcastToGame(gameId, {
        type: 'move-committed',
        gameId,
        snakeId,
        move,
        source,
        // Refresh staged moves so the committing snake flips to its double
        // (committed) arrow immediately, not only on the next broadcast.
        stagedMoves: this.getStagedMovesForGame(gameId),
        routes: this.gameManager.getRoutesForGame(gameId),
        activeIntentModes: this.gameManager.getActiveIntentModesForGame(gameId),
      });
    });

    this.gameManager.onGameListChange((event, gameId, snakeId) => {
      console.log(`[WebSocket] Game list changed: ${event} ${gameId}:${snakeId}`);
      this.broadcastLobbyUpdate();
    });

    // Reactive staged-arrow sync: the game manager coalesces every staged-move
    // / intent change into one notification per game per tick, so we just push
    // the current selections snapshot (which carries staged moves, premoves,
    // waypoints, routes and intent modes) to subscribers.
    this.gameManager.onStagedChange((gameId) => {
      this.broadcastSelectionsUpdate(gameId);
    });

    // Fatal-move consent gate: when the manager blocks an unconsented human
    // certain-death move, prompt ONLY the controlling user to confirm it.
    this.gameManager.onFatalConfirmationNeeded((gameId, snakeId, move, turn) => {
      const game = this.gameManager.getGame(gameId);
      const userId = game?.controlledSnakes.get(snakeId)?.selectedBy;
      if (!userId) return;
      this.sendToUser(gameId, userId, {
        type: 'fatal-move-confirmation-needed',
        gameId,
        snakeId,
        move,
        turn,
      });
    });

    this.gameManager.onGameEnd((gameId, snakeId, finalGameState, gameOver) => {
      const finalSnakes = finalGameState.board?.snakes || [];
      const survived = finalSnakes.some(s => s.id === snakeId);
      const won = survived && finalSnakes.length === 1;
      const clientCount = this.clientsForGame(gameId);
      console.log(
        `[WS] broadcasting snake-ended for ${gameId}:${snakeId} — turn=${finalGameState.turn}, gameOver=${gameOver}, survived=${survived}, subscribers=${clientCount}`,
      );
      this.broadcastToGame(gameId, {
        type: 'snake-ended',
        gameId,
        snakeId,
        turn: finalGameState.turn,
        finalGameState,
        survived,
        won,
        gameOver,
      });
    });
  }

  private handleMessage(client: WSClient, msg: WSMessage): void {
    switch (msg.type) {
      case 'subscribe-game': {
        const gameId = msg.gameId || '';
        const userId = msg.userId || '';
        client.gameId = gameId;
        client.userId = userId;
        client.isLobby = false;

        // Subscribing is NOT user intent (the auto-reconnect loop re-subscribes
        // on every proxy drop). Restore this user's real idle clock so the
        // sweep sees continuity across reconnects; first-time users start now.
        const known = userId ? this.userActivity.get(userId) : undefined;
        if (known !== undefined) {
          client.lastActivityAt = known;
        } else if (userId) {
          this.userActivity.set(userId, client.lastActivityAt);
        }

        this.connLogger.log({
          ts: Date.now(),
          side: 'server',
          type: 'server-subscribe',
          connId: client.connId,
          gameId,
          userId,
          ip: client.ip,
          details: { kind: 'game' },
        });

        const user = this.gameManager.addConnectedUser(gameId, userId);
        const gameState = this.gameManager.getGameState(gameId);

        this.send(client.ws, {
          type: 'game-subscribed',
          gameId,
          userId,
          userColor: user?.color || '#888888',
          ...(gameState || {}),
        });

        this.broadcastSelectionsUpdate(gameId);
        break;
      }

      case 'set-commit-buffer': {
        if (!client.gameId) break;
        const applied = this.gameManager.setCommitBuffer(client.gameId, msg.bufferMs);
        if (applied !== null) {
          // Broadcast so every viewer's countdown uses the same buffer.
          this.broadcastToGame(client.gameId, {
            type: 'commit-buffer-update',
            gameId: client.gameId,
            commitBufferMs: applied,
          });
        }
        break;
      }

      case 'select-snake': {
        if (!client.gameId || !client.userId) break;
        const snakeId = msg.snakeId;
        const force = !!msg.force;

        const result = this.gameManager.selectSnake(client.gameId, snakeId, client.userId, force);

        if (result.success) {
          this.broadcastSelectionsUpdate(client.gameId);

          if (result.revokedUserId) {
            this.sendToUser(client.gameId, result.revokedUserId, {
              type: 'selection-revoked',
              snakeId,
            });
          }

          const game = this.gameManager.getGame(client.gameId);
          const controlled = game?.controlledSnakes.get(snakeId);
          if (controlled) {
            this.send(client.ws, {
              type: 'snake-selected',
              snakeId,
              turnData: controlled.latestTurnData,
              moveCommitted: controlled.moveCommittedThisTurn,
              committedMove: controlled.committedMove,
              botRecommendation: controlled.botRecommendation,
              stagedMove: controlled.intent.kind === 'manual' ? controlled.intent.move : null,
            });
          }
        } else if (result.contestedBy) {
          this.send(client.ws, {
            type: 'selection-contested',
            snakeId,
            contestedBy: result.contestedBy,
          });
        }
        break;
      }

      case 'deselect': {
        if (!client.gameId || !client.userId) break;
        this.gameManager.deselectSnake(client.gameId, client.userId);
        this.broadcastSelectionsUpdate(client.gameId);
        break;
      }

      case 'hold-snake': {
        if (!client.gameId || !client.userId) break;
        const snakeId = msg.snakeId;
        if (!snakeId) break;
        const result = this.gameManager.holdSnake(client.gameId, snakeId, client.userId);
        this.send(client.ws, {
          type: 'hold-result',
          snakeId,
          success: result.success,
          holdTurnsRemaining: result.holdTurnsRemaining,
        });
        this.broadcastSelectionsUpdate(client.gameId);
        break;
      }

      case 'release-all-holds': {
        if (!client.gameId || !client.userId) break;
        this.gameManager.releaseAllHolds(client.gameId);
        this.broadcastSelectionsUpdate(client.gameId);
        break;
      }

      case 'commit-all-staged': {
        // Benign "commit now" action — no password. Immediately commits the
        // staged move for every controlled snake with an unresolved pending
        // move, ending the wait for the per-snake safety timer.
        if (!client.gameId || !client.userId) break;
        this.gameManager.commitAllStaged(client.gameId);
        this.broadcastSelectionsUpdate(client.gameId);
        break;
      }

      case 'suicide-all': {
        if (!client.gameId || !client.userId) break;
        // The shared secret is stored as a SHA-512 hash so the plaintext
        // password never lives in the repo. The client sends the raw input;
        // we hash it server-side and compare.
        const expectedHash = 'b109f3bbbc244eb82441917ed06d618b9008dd09b3befd1b5e07394c706a8bb980b1d7785e5976ec049b46df5f1326af5a2ea6d103fd07c95385ffab0cacbc86';
        const input = typeof msg.password === 'string' ? msg.password : '';
        const actualHash = createHash('sha512').update(input).digest('hex');
        if (actualHash !== expectedHash) {
          this.send(client.ws, { type: 'suicide-result', success: false, error: 'Invalid password' });
          break;
        }
        const result = this.gameManager.suicideAllSnakes(client.gameId);
        this.send(client.ws, { type: 'suicide-result', success: true, affected: result.affected });
        this.broadcastSelectionsUpdate(client.gameId);
        break;
      }

      case 'select-move': {
        // Space (or the Stage button) on the client stages the inspected cell
        // as the snake's manual next move. This only STAGES — the move commits
        // at the turn deadline via the per-snake safety timer. Manual staging
        // drops the queue/waypoint per the "manual override drops the plan"
        // contract (handled inside setUserSelection).
        const validMoves: Direction[] = ['up', 'down', 'left', 'right'];
        const snakeId = msg.snakeId;
        if (client.gameId && client.userId && snakeId && msg.move && validMoves.includes(msg.move)) {
          const game = this.gameManager.getGame(client.gameId);
          const controlled = game?.controlledSnakes.get(snakeId);
          if (controlled && controlled.selectedBy === client.userId) {
            // setUserSelection re-stages the move, which fires the coalesced
            // onStagedChange → broadcastSelectionsUpdate; no explicit broadcast.
            this.gameManager.setUserSelection(client.gameId, snakeId, msg.move as Direction);
          }
        }
        break;
      }

      case 'confirm-fatal-move': {
        // The user accepted the fatal-move confirmation dialog. The manager
        // re-validates fatality server-side and mints the consent brand there;
        // this message is only the claim. Late confirmations (turn already
        // committed) return false and are reported back.
        const validMoves: Direction[] = ['up', 'down', 'left', 'right'];
        const snakeId = msg.snakeId;
        if (client.gameId && client.userId && snakeId && msg.move && validMoves.includes(msg.move)) {
          const staged = this.gameManager.confirmFatalMove(
            client.gameId, snakeId, msg.move as Direction, client.userId
          );
          this.send(client.ws, { type: 'confirm-fatal-move-result', snakeId, move: msg.move, staged });
        }
        break;
      }

      case 'set-premove': {
        if (!client.gameId || !client.userId) break;
        const snakeId = msg.snakeId;
        if (!snakeId) break;
        // On success setPremoveQueue re-stages the move, firing the coalesced
        // onStagedChange → broadcastSelectionsUpdate; no explicit broadcast.
        this.gameManager.setPremoveQueue(
          client.gameId, snakeId, msg.queue, client.userId
        );
        break;
      }

      case 'set-waypoint': {
        if (!client.gameId || !client.userId) break;
        const snakeId = msg.snakeId;
        if (!snakeId) break;
        // msg.waypoint may be null (clear) or {type, x, y}. On success
        // setWaypoint re-stages the move, firing the coalesced onStagedChange →
        // broadcastSelectionsUpdate; no explicit broadcast.
        this.gameManager.setWaypoint(
          client.gameId, snakeId, msg.waypoint ?? null, client.userId
        );
        break;
      }

      case 'set-nickname': {
        if (!client.gameId || !client.userId) break;
        const nickname = typeof msg.nickname === 'string' ? msg.nickname : null;
        const success = this.gameManager.setUserNickname(client.gameId, client.userId, nickname);
        if (success) {
          this.broadcastSelectionsUpdate(client.gameId);
        }
        break;
      }

      case 'subscribe-lobby':
        client.isLobby = true;
        client.gameId = '';
        client.userId = '';
        this.connLogger.log({
          ts: Date.now(),
          side: 'server',
          type: 'server-subscribe',
          connId: client.connId,
          ip: client.ip,
          details: { kind: 'lobby' },
        });
        this.sendLobbyState(client.ws);
        break;

      case 'ping': {
        const serverTime = Date.now();
        this.send(client.ws, {
          type: 'pong',
          serverTime,
          clientTime: msg.clientTime || null,
        });
        break;
      }

      case 'activity': {
        // Heartbeat from IdleWatcher signalling the user has been active.
        // lastActivityAt was already bumped above by the USER_INTENT_TYPES
        // check; nothing more to do here. Don't reply — a silent ack keeps
        // this off the wire when the tab is idle.
        break;
      }

      case 'keepalive': {
        // Unconditional connection keepalive from the client. Deliberately NOT
        // in USER_INTENT_TYPES, so it keeps the socket warm (and proxy idle
        // timer reset) without resetting the 30-minute user-idle window. The
        // inbound frame already marked isAlive above; nothing else to do.
        break;
      }
    }
  }

  /**
   * Protocol-level keepalive. Every interval, terminate any socket that didn't
   * answer the previous ping (genuinely dead/zombie), then ping the rest. We
   * also send a lightweight application-level `keepalive` frame on the same
   * cadence: the platform proxy is known to forward application data frames
   * (board updates flow through it), but may not forward low-level ping frames,
   * so the app-level frame guarantees server→client traffic keeps the idle-but-
   * open socket from being dropped (~5-minute proxy window).
   */
  private startKeepalive(): void {
    if (this.keepaliveInterval) return;
    const keepaliveData = JSON.stringify({ type: 'keepalive', ts: 0 });
    this.keepaliveInterval = setInterval(() => {
      for (const client of this.clients) {
        if (client.ws.readyState !== WebSocket.OPEN) continue;
        if (!client.isAlive) {
          // Missed a full interval without any inbound frame or pong — treat as
          // a dead socket and terminate so the client reconnects fresh.
          console.log(
            `[WebSocket] Keepalive: terminating dead conn=${client.connId} ` +
              `user=${client.userId || '-'} game=${client.gameId || '-'}`,
          );
          this.connLogger.log({
            ts: Date.now(),
            side: 'server',
            type: 'server-keepalive-terminate',
            connId: client.connId,
            gameId: client.gameId || undefined,
            userId: client.userId || undefined,
            ip: client.ip,
            durationMs: Date.now() - client.connectedAt,
          });
          try { client.ws.terminate(); } catch { /* already tearing down */ }
          continue;
        }
        // Expect a pong (or any inbound frame) before the next sweep.
        client.isAlive = false;
        try { client.ws.ping(); } catch { /* best-effort */ }
        // App-level keepalive as the proxy-forwarding fallback.
        try { client.ws.send(keepaliveData); } catch { /* best-effort */ }
      }
    }, WS_KEEPALIVE_INTERVAL_MS);
    // Don't keep the event loop alive solely for the keepalive timer.
    if (typeof this.keepaliveInterval.unref === 'function') {
      this.keepaliveInterval.unref();
    }
  }

  /** Stop background timers so the process can shut down cleanly. */
  shutdown(): void {
    if (this.idleSweepInterval) {
      clearInterval(this.idleSweepInterval);
      this.idleSweepInterval = null;
    }
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }
  }

  private startIdleSweep(): void {
    if (this.idleSweepInterval) return;
    this.idleSweepInterval = setInterval(async () => {
      // With zero clients there is nothing to sweep — skip entirely (including
      // the config read) so an idle server generates no background database
      // traffic that could keep the autoscale instance from draining to zero.
      if (this.clients.size === 0) {
        if (this.userActivity.size > 0) {
          const pruneCutoff = Date.now() - this.idleTimeoutMs * 2;
          for (const [userId, ts] of this.userActivity) {
            if (ts < pruneCutoff) this.userActivity.delete(userId);
          }
        }
        return;
      }
      // Refresh the timeout from config (best-effort; keep last value on error).
      try {
        const minutes = await this.configStore.get('idleTimeoutMinutes');
        if (typeof minutes === 'number' && minutes > 0) {
          this.idleTimeoutMs = minutes * 60 * 1000;
        } else if (minutes === undefined) {
          this.idleTimeoutMs = DEFAULT_CONFIG.idleTimeoutMinutes * 60 * 1000;
        }
      } catch { /* keep current value */ }

      const cutoff = Date.now() - this.idleTimeoutMs;
      for (const client of this.clients) {
        if (client.ws.readyState !== WebSocket.OPEN) continue;
        if (client.lastActivityAt < cutoff) {
          const idleFor = Date.now() - client.lastActivityAt;
          console.log(
            `[WebSocket] Idle sweep: closing conn=${client.connId} ` +
              `user=${client.userId || '-'} game=${client.gameId || '-'} ` +
              `idleFor=${Math.round(idleFor / 1000)}s`,
          );
          this.connLogger.log({
            ts: Date.now(),
            side: 'server',
            type: 'server-idle-close',
            connId: client.connId,
            gameId: client.gameId || undefined,
            userId: client.userId || undefined,
            ip: client.ip,
            code: IDLE_CLOSE_CODE,
            reason: IDLE_CLOSE_REASON,
            durationMs: Date.now() - client.connectedAt,
            details: { idleForMs: idleFor },
          });
          try {
            client.ws.close(IDLE_CLOSE_CODE, IDLE_CLOSE_REASON);
          } catch (e) {
            // best-effort: socket may already be tearing down
          }
        }
      }
      // Prune stale per-user activity records so the map can't grow without
      // bound. Anything older than 2× the idle window is long past useful —
      // any connection restoring it would be swept immediately anyway.
      const pruneCutoff = Date.now() - this.idleTimeoutMs * 2;
      for (const [userId, ts] of this.userActivity) {
        if (ts < pruneCutoff) this.userActivity.delete(userId);
      }
    }, SERVER_IDLE_SWEEP_INTERVAL_MS);
    // Don't keep the event loop alive solely for the sweep timer.
    if (typeof this.idleSweepInterval.unref === 'function') {
      this.idleSweepInterval.unref();
    }
  }

  /** Emit a single line whenever the active-connection count changes. Called
   *  from the add/delete sites so every transition shows up exactly once. */
  private logActiveConnections(reason: string, connId: string): void {
    console.log(
      `[WebSocket] Active connections: ${this.clients.size} ` +
        `(${reason} conn=${connId})`,
    );
    // Feed every connection-count change into the activity tracker so 0↔1
    // transitions emit went-idle / woke server events (includes idle-sweep
    // closes — they arrive here via the socket's close handler).
    ServerEventLogger.getInstance().setConnectionCount(this.clients.size);
  }

  private handleDisconnect(client: WSClient): void {
    if (client.gameId && client.userId) {
      this.gameManager.removeConnectedUser(client.gameId, client.userId);
      this.broadcastSelectionsUpdate(client.gameId);
    }
  }

  private getSelectionsForGame(gameId: string): { [snakeId: string]: { userId: string; color: string } | null } {
    const game = this.gameManager.getGame(gameId);
    if (!game) return {};

    const selections: { [snakeId: string]: { userId: string; color: string } | null } = {};
    for (const [snakeId, cs] of game.controlledSnakes) {
      if (cs.selectedBy) {
        const user = game.connectedUsers.get(cs.selectedBy);
        selections[snakeId] = {
          userId: cs.selectedBy,
          color: user?.color || '#888888',
        };
      } else {
        selections[snakeId] = null;
      }
    }
    return selections;
  }

  // Staged moves are the single source of truth for the staged-arrow render on
  // every client. Both the staged arrow and the committed move are pure reads of
  // the server-maintained `staged` / `committedMove` fields — they can never
  // diverge from what the deadline commit will use. Color/source are derived from
  // the staged record's source: heuristic = grey/'bot' (bot-seeded), any human
  // method (manual/queue/waypoint) = the controlling user's color.
  //
  // Every controlled snake gets an entry, gated ONLY on having a `staged` record
  // — NOT on an in-flight pendingMove. The client only draws an arrow for snakes
  // present on the board, so eliminated snakes are naturally skipped there.
  private getStagedMovesForGame(gameId: string): { [snakeId: string]: { move: string; committed: boolean; color: string; source: string; fatal: boolean } } {
    const game = this.gameManager.getGame(gameId);
    if (!game) return {};

    const BOT_COLOR = '#888888';
    const staged: { [snakeId: string]: { move: string; committed: boolean; color: string; source: string; fatal: boolean } } = {};
    for (const [snakeId, cs] of game.controlledSnakes) {
      const userColor = cs.selectedBy
        ? game.connectedUsers.get(cs.selectedBy)?.color || '#4CAF50'
        : '#4CAF50';
      // Colour/source reflect the TRUE origin of the staged move, NOT the nominal
      // activeIntentMode. A waypoint/queue that fell back to the bot's move this
      // turn has source 'bot'/'fallback' and renders grey — so a user-coloured
      // arrow always guarantees the user's own move will commit (Bug A).
      const isBot = cs.staged?.source === 'bot' || cs.staged?.source === 'fallback';
      const color = isBot ? BOT_COLOR : userColor;
      // `fatal` flags a certain-death move so the client can warn the human; it
      // NEVER changes what commits (the staged move is sacrosanct).
      const fatal = this.gameManager.isStagedMoveFatal(gameId, snakeId);
      if (cs.moveCommittedThisTurn && cs.committedMove) {
        staged[snakeId] = { move: cs.committedMove, committed: true, color, source: 'committed', fatal };
        continue;
      }
      if (!cs.staged) continue;
      staged[snakeId] = { move: cs.staged.move, committed: false, color, source: cs.staged.source, fatal };
    }
    return staged;
  }

  private broadcastSelectionsUpdate(gameId: string): void {
    const game = this.gameManager.getGame(gameId);
    if (!game) return;

    const selections = this.getSelectionsForGame(gameId);
    const connectedUsers = Array.from(game.connectedUsers.values());
    const holds = this.gameManager.getHoldStates(gameId);
    const stagedMoves = this.getStagedMovesForGame(gameId);
    const premoves = this.gameManager.getPremovesForGame(gameId);
    const waypoints = this.gameManager.getWaypointsForGame(gameId);
    const routes = this.gameManager.getRoutesForGame(gameId);
    const activeIntentModes = this.gameManager.getActiveIntentModesForGame(gameId);

    this.broadcastToGame(gameId, {
      type: 'selections-update',
      selections,
      connectedUsers,
      holds,
      stagedMoves,
      premoves,
      waypoints,
      routes,
      activeIntentModes,
    });
  }

  private sendToUser(gameId: string, userId: string, msg: any): void {
    const data = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.gameId === gameId && client.userId === userId && client.ws.readyState === WebSocket.OPEN) {
        this.sendRaw(client, data, msg.type);
      }
    }
  }

  private sendLobbyState(ws: WebSocket): void {
    const games = this.gameManager.getActiveGames();
    this.send(ws, {
      type: 'lobby-update',
      games,
    });
  }

  private broadcastLobbyUpdate(): void {
    const games = this.gameManager.getActiveGames();
    const msg = { type: 'lobby-update', games };
    const data = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.isLobby && client.ws.readyState === WebSocket.OPEN) {
        this.sendRaw(client, data, msg.type);
      }
    }
  }

  private broadcastToGame(gameId: string, msg: any): void {
    const data = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.gameId === gameId && !client.isLobby && client.ws.readyState === WebSocket.OPEN) {
        this.sendRaw(client, data, msg.type);
      }
    }
  }

  /** Count live (OPEN, non-lobby) subscribers currently watching a game. Used
   *  for diagnostics so we can tell whether a snake-ended broadcast actually had
   *  any client to reach. */
  private clientsForGame(gameId: string): number {
    let n = 0;
    for (const client of this.clients) {
      if (client.gameId === gameId && !client.isLobby && client.ws.readyState === WebSocket.OPEN) {
        n++;
      }
    }
    return n;
  }

  private send(ws: WebSocket, msg: any): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    // Best-effort backpressure check for direct (non-client-tracked) sends.
    if ((ws as any).bufferedAmount > BACKPRESSURE_TERMINATE_BYTES) {
      try { ws.terminate(); } catch {}
      return;
    }
    ws.send(JSON.stringify(msg));
  }

  /**
   * Send with backpressure handling. If the socket's send buffer is over the
   * threshold, drop superseded update types (board-update / snake-turn-update /
   * selections-update / lobby-update — the next turn supersedes them) instead
   * of letting Node buffer unbounded data for a slow/zombie client. If the
   * buffer stays high for a sustained period, terminate the connection so the
   * client can reconnect fresh.
   */
  private sendRaw(client: WSClient, data: string, msgType: string): void {
    const ws = client.ws;
    if (ws.readyState !== WebSocket.OPEN) return;

    const buffered = (ws as any).bufferedAmount as number;

    if (buffered > BACKPRESSURE_TERMINATE_BYTES) {
      console.warn(
        `[WebSocket] Backpressure terminate: conn=${client.connId} ` +
          `user=${client.userId || '-'} bufferedAmount=${buffered}B`,
      );
      this.connLogger.log({
        ts: Date.now(),
        side: 'server',
        type: 'server-backpressure-terminate',
        connId: client.connId,
        gameId: client.gameId || undefined,
        userId: client.userId || undefined,
        ip: client.ip,
        details: { bufferedAmount: buffered, msgType },
      });
      try { ws.terminate(); } catch {}
      return;
    }

    if (buffered > BACKPRESSURE_DROP_BYTES && SUPERSEDED_MSG_TYPES.has(msgType)) {
      this.connLogger.log({
        ts: Date.now(),
        side: 'server',
        type: 'server-backpressure-drop',
        connId: client.connId,
        gameId: client.gameId || undefined,
        userId: client.userId || undefined,
        ip: client.ip,
        details: { bufferedAmount: buffered, msgType },
      });
      return;
    }

    ws.send(data);
  }
}

// 1 MB — drop superseded updates (next turn replaces them anyway) beyond this.
const BACKPRESSURE_DROP_BYTES = 1024 * 1024;
// 4 MB — terminate the socket; the client can reconnect and resync from scratch.
const BACKPRESSURE_TERMINATE_BYTES = 4 * 1024 * 1024;
const SUPERSEDED_MSG_TYPES = new Set([
  'board-update',
  'snake-turn-update',
  'selections-update',
  'lobby-update',
]);
