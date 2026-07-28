import { GameState, BoardSnapshot, Direction, Coord } from '../types/battlesnake';
import { Response } from 'express';
import { BoardEvaluator } from '../logic/board-evaluator';
import { BoardGraph } from '../logic/board-graph';
import { DecisionLogger } from '../logic/decision-logger';

export interface MoveEvaluation {
  move: Direction;
  score: number;
  numStates: number;
  breakdown: any;
  projectedTerritoryCells?: { [snakeId: string]: { x: number; y: number }[] };
}

export interface TurnData {
  gameState: GameState;
  moveEvaluations: MoveEvaluation[];
  territoryCells: { [snakeId: string]: { x: number; y: number }[] };
  safeMoves: Direction[];
  botRecommendation: Direction | null;
  timestamp: number;
}

// Per-turn request transport. Holds the open HTTP response, its safety timer,
// the turn's bot data, and the turn it answers — but NOT the snake's intention,
// which lives durably on `ControlledSnake.intent` (see SnakeIntent).
interface PendingMove {
  res: Response;
  timer: NodeJS.Timeout;
  turnData: TurnData | null;
  botMove: Direction | null;
  resolved: boolean;
  // The turn this pending move is answering. Each commit site uses it to validate
  // the staged record is bound to the same turn (see StagedMove). For
  // previous-turn-cleanup the relevant turn is the PRIOR pending's turn.
  turn: number;
}

export type IntendedMoveSource = 'manual' | 'queue' | 'waypoint' | 'bot' | 'fallback';

// ── Fatal-move consent brand ────────────────────────────────────────────────
// A branded value proving a HUMAN explicitly consented to staging a
// certain-death move. There are exactly TWO mint points, both server-side and
// both inside this module (the symbol and mint function are deliberately NOT
// exported, so no other code path can forge consent):
//   1. confirmFatalMove — the dialog-accept message handler's entry point,
//      which re-validates fatality server-side before minting.
//   2. The kill-all / armed-suicide path, which is deliberate death by design.
// The brand rides on the manual intent, flows through computeIntendedMove into
// stageMove (the single staged-move writer), which refuses to stage an
// unconsented human certain-death move and falls back to the bot's move.
declare const fatalConsentBrand: unique symbol;
export type FatalMoveConsent = { readonly [fatalConsentBrand]: true };
function mintFatalMoveConsent(): FatalMoveConsent {
  return Object.freeze({}) as FatalMoveConsent;
}

export interface IntendedMove {
  direction: Direction;
  source: IntendedMoveSource;
  // Present only when a manual intent carries fatal-move consent.
  consent?: FatalMoveConsent;
}

// A controlled snake's resolved next move, bound as one atomic value to the
// (snakeId, turn) it was computed for. Written only by `stageMove`, replaced as
// a whole (its fields are readonly — never mutate one in place), and accepted at
// commit only through `stagedMoveForTurn`, which honours it solely when both the
// snake and turn align. `null` means there is no staged move for the snake.
export interface StagedMove {
  readonly snakeId: string;
  readonly turn: number;
  readonly move: Direction;
  readonly source: IntendedMoveSource;
  // True when this move carried explicit fatal-move consent (the user confirmed
  // the certain-death dialog, or used kill-all). Recorded onto the decision log
  // at commit so replays can distinguish a deliberate death from a bot mistake.
  readonly fatalConsented: boolean;
}

// A controlled snake's intention: ONE discriminated union, so two sources can
// never be populated at once (mutual exclusion is structural, not enforced by
// clearing logic). Set only through `setIntent`, which re-stages the move.
//  - heuristic: no user direction — the bot's recommendation drives the move
//  - manual:    the user picked a specific next move (single-turn; reset each turn)
//  - queue:     a multi-step premove path executing one cell per turn (persists)
//  - waypoint:  a click-target biasing the bot toward a cell (persists); green
//               'goto' carries a live `route`, blue 'near' leaves it empty
export type SnakeIntent =
  | { kind: 'heuristic' }
  | { kind: 'manual'; move: Direction; fatalConsent?: FatalMoveConsent }
  | { kind: 'queue'; cells: Coord[] }
  | { kind: 'waypoint'; style: 'green' | 'blue'; target: Coord; route: Coord[] };

// The active next-move source, exposed to clients as `activeIntentModes`. Mirrors
// the union's discriminant so the client contract is unchanged.
export type IntentMode = SnakeIntent['kind'];

export interface SnakeInfo {
  id: string;
  name: string;
  emoji: string;
}

export interface ControlledSnake {
  id: string;
  name: string;
  emoji: string;
  pendingMove: PendingMove | null;
  latestTurnData: TurnData | null;
  botRecommendation: Direction | null;
  selectedBy: string | null;
  moveCommittedThisTurn: boolean;
  committedMove: Direction | null;
  holdTurnsRemaining: number;
  suicideArmed: boolean;
  // The snake's intention — the single source of truth for queue cells, the
  // waypoint + its live goto route, the manual selection, and the active mode.
  // Set only through `setIntent`. The client-facing projections (premoves,
  // waypoints, routes, activeIntentModes) are derived from this.
  intent: SnakeIntent;
  // The next move that will commit at the turn deadline, bound to its
  // (snakeId, turn). Written only by `stageMove`; the safety-timer commit and the
  // staged-arrow broadcast are pure reads. `null` until staged for the turn.
  staged: StagedMove | null;
  // Dedupe for the fatal-move confirmation prompt: the (turn, move) we last
  // asked the user to confirm, so repeated re-stages within the same turn
  // don't spam the dialog.
  fatalPromptTurn: number | null;
  fatalPromptMove: Direction | null;
}

export interface ConnectedUser {
  userId: string;
  color: string;
  selectedSnakeId: string | null;
  nickname: string | null;
}

export interface ActiveGame {
  gameId: string;
  boardState: BoardSnapshot | null;
  boardStateTurn: number;
  snakes: Map<string, SnakeInfo>;
  controlledSnakes: Map<string, ControlledSnake>;
  connectedUsers: Map<string, ConnectedUser>;
  gameTimeout: number;
  startedAt: number;
  lastActivityAt: number;
  colorPool: string[];
  // Persistent userId→colour association. Outlives a disconnect so a user who
  // reconnects (same sessionStorage userId) reclaims their previous colour
  // instead of being handed a fresh one off the pool. Entries are removed only
  // when the reconnect grace window expires or the game is cleaned up.
  userColors: Map<string, string>;
  // Pending colour-release timers keyed by userId. A disconnect schedules one;
  // a reconnect within the grace window cancels it. When it fires, the colour
  // is returned to the pool and the userColors entry dropped.
  colorReleaseTimers: Map<string, NodeJS.Timeout>;
  turnExpiryTime: number | null;
  currentTurn: number;
  // User-configurable safety-timer buffer (ms). The safety timer commits the
  // staged move at gameServerDeadline − commitBufferMs. Adjustable live from
  // the play page; shared by all viewers of the game.
  commitBufferMs: number;
  // The buffer actually used to arm the current turn's safety timer. Differs
  // from commitBufferMs on turn 0 (warm-up) and when the setting changes
  // mid-turn (the armed timer keeps the old value). Clients count down with
  // this so 0.0s always coincides with the real commit moment.
  effectiveCommitBufferMs: number;
}

export const DEFAULT_COMMIT_BUFFER_MS = 500;
export const MIN_COMMIT_BUFFER_MS = 100;
export const MAX_COMMIT_BUFFER_MS = 5000;

const DISTINCT_COLORS = [
  '#e6194B', '#f58231', '#ffe119', '#bfef45',
  '#3cb44b', '#42d4f4', '#4363d8', '#911eb4',
  '#f032e6',
];

// How long a disconnected user's colour is held in reserve before it's released
// back to the pool. A transient drop (proxy blip, brief network loss) reconnects
// well within this window — the client retries after ~2s — so the user keeps the
// same colour with no churn. Only a real departure (no reconnect) frees it.
const COLOR_RELEASE_GRACE_MS = 60 * 1000;

export type TurnUpdateCallback = (gameId: string, snakeId: string, turnData: TurnData) => void;
export type BoardUpdateCallback = (gameId: string, gameState: GameState) => void;
export type MoveCommittedCallback = (gameId: string, snakeId: string, move: Direction, source: string) => void;
export type GameListChangeCallback = (event: 'added' | 'removed' | 'updated', gameId: string, snakeId: string) => void;
export type GameEndCallback = (gameId: string, snakeId: string, finalGameState: GameState, gameOver: boolean) => void;
// Fired (coalesced once per event-loop tick) whenever any controlled snake's
// staged move / intent changed, so the WS layer can push the staged-arrow +
// intent projections without each mutation site broadcasting explicitly.
export type StagedChangeCallback = (gameId: string) => void;
// Fired when a human-sourced staged move was blocked by the fatal-move consent
// gate — the client should show the confirmation dialog for (snakeId, move).
export type FatalConfirmationCallback = (gameId: string, snakeId: string, move: Direction, turn: number) => void;

export class ActiveGameManager {
  private static instance: ActiveGameManager;
  private games: Map<string, ActiveGame> = new Map();
  private turnUpdateCallbacks: TurnUpdateCallback[] = [];
  private boardUpdateCallbacks: BoardUpdateCallback[] = [];
  private moveCommittedCallbacks: MoveCommittedCallback[] = [];
  private gameListChangeCallbacks: GameListChangeCallback[] = [];
  private gameEndCallbacks: GameEndCallback[] = [];
  private stagedChangeCallbacks: StagedChangeCallback[] = [];
  private fatalConfirmationCallbacks: FatalConfirmationCallback[] = [];
  // Games whose staged move changed since the last flush. Coalesced into one
  // notification per event-loop tick so a burst of stageMove calls within a
  // single operation broadcasts at most once.
  private stagedDirtyGames: Set<string> = new Set();
  private stagedFlushScheduled: boolean = false;
  private gameServerPing: number = 50;
  private pingInterval: NodeJS.Timer | null = null;
  private staleGameCleanupInterval: NodeJS.Timer | null = null;
  // Used to compute a green waypoint's goto route the moment it's set, so the
  // path shows immediately instead of waiting for the next /move.
  private routeEvaluator: BoardEvaluator = new BoardEvaluator();

  private constructor() {}

  static getInstance(): ActiveGameManager {
    if (!ActiveGameManager.instance) {
      ActiveGameManager.instance = new ActiveGameManager();
    }
    return ActiveGameManager.instance;
  }

  onTurnUpdate(callback: TurnUpdateCallback): void {
    this.turnUpdateCallbacks.push(callback);
  }

  onBoardUpdate(callback: BoardUpdateCallback): void {
    this.boardUpdateCallbacks.push(callback);
  }

  onMoveCommitted(callback: MoveCommittedCallback): void {
    this.moveCommittedCallbacks.push(callback);
  }

  onGameListChange(callback: GameListChangeCallback): void {
    this.gameListChangeCallbacks.push(callback);
  }

  onGameEnd(callback: GameEndCallback): void {
    this.gameEndCallbacks.push(callback);
  }

  onStagedChange(callback: StagedChangeCallback): void {
    this.stagedChangeCallbacks.push(callback);
  }

  onFatalConfirmationNeeded(callback: FatalConfirmationCallback): void {
    this.fatalConfirmationCallbacks.push(callback);
  }

  private notifyFatalConfirmationNeeded(gameId: string, snakeId: string, move: Direction, turn: number): void {
    for (const cb of this.fatalConfirmationCallbacks) {
      try {
        cb(gameId, snakeId, move, turn);
      } catch (e) {
        console.error('Error in fatal confirmation callback:', e);
      }
    }
  }

  // Mark a game's staged move as changed. Coalesces a burst of stageMove calls
  // (e.g. setIntent → stageMove, or per-snake re-staging) into a single
  // notification per event-loop tick. Uses setImmediate().unref() so a pending
  // flush never keeps the process alive on its own.
  private notifyStagedChange(gameId: string): void {
    this.stagedDirtyGames.add(gameId);
    if (this.stagedFlushScheduled) return;
    this.stagedFlushScheduled = true;
    setImmediate(() => {
      this.stagedFlushScheduled = false;
      const dirty = Array.from(this.stagedDirtyGames);
      this.stagedDirtyGames.clear();
      for (const id of dirty) {
        for (const cb of this.stagedChangeCallbacks) {
          try {
            cb(id);
          } catch (e) {
            console.error('Error in staged change callback:', e);
          }
        }
      }
    }).unref();
  }

  private notifyGameEnd(gameId: string, snakeId: string, finalGameState: GameState, gameOver: boolean): void {
    for (const cb of this.gameEndCallbacks) {
      try {
        cb(gameId, snakeId, finalGameState, gameOver);
      } catch (e) {
        console.error('Error in game end callback:', e);
      }
    }
  }

  private notifyGameListChange(event: 'added' | 'removed' | 'updated', gameId: string, snakeId: string): void {
    for (const cb of this.gameListChangeCallbacks) {
      try {
        cb(event, gameId, snakeId);
      } catch (e) {
        console.error('Error in game list change callback:', e);
      }
    }
  }

  private notifyTurnUpdate(gameId: string, snakeId: string, turnData: TurnData): void {
    for (const cb of this.turnUpdateCallbacks) {
      try {
        cb(gameId, snakeId, turnData);
      } catch (e) {
        console.error('Error in turn update callback:', e);
      }
    }
  }

  private notifyBoardUpdate(gameId: string, gameState: GameState): void {
    for (const cb of this.boardUpdateCallbacks) {
      try {
        cb(gameId, gameState);
      } catch (e) {
        console.error('Error in board update callback:', e);
      }
    }
  }

  private notifyMoveCommitted(gameId: string, snakeId: string, move: Direction, source: string): void {
    for (const cb of this.moveCommittedCallbacks) {
      try {
        cb(gameId, snakeId, move, source);
      } catch (e) {
        console.error('Error in move committed callback:', e);
      }
    }
  }

  getMeasuredPing(): number {
    return this.gameServerPing;
  }

  recordTurnArrival(gameId: string, arrivalTime: number, gameTimeout: number, serverExpiryTime: number | null = null): void {
    const game = this.games.get(gameId);
    if (!game) return;

    if (serverExpiryTime) {
      game.turnExpiryTime = serverExpiryTime;
    } else {
      game.turnExpiryTime = arrivalTime + gameTimeout - this.gameServerPing;
    }
  }

  startServerPing(gameServerUrl: string = 'https://engine.battlesnake.com'): void {
    if (this.pingInterval) return;

    const pingGameServer = async () => {
      // Only measure ping while games are actually running. A truly idle
      // server must generate zero background network traffic, or the
      // autoscale platform may never consider the instance quiescent.
      if (this.games.size === 0) return;
      try {
        const start = Date.now();
        const response = await fetch(gameServerUrl, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
        const elapsed = Date.now() - start;
        if (response.ok || response.status < 500) {
          this.gameServerPing = this.gameServerPing > 0
            ? Math.round(this.gameServerPing * 0.7 + elapsed * 0.3)
            : elapsed;
        }
      } catch {
      }
    };

    pingGameServer();
    this.pingInterval = setInterval(pingGameServer, 30000);
    // Keep the ping running for the whole process lifetime (simplest, and the
    // measured ping stays warm for when a game registers), but unref it so this
    // short-cycle timer never keeps the Node event loop alive on its own. That
    // lets the autoscale instance go genuinely idle and drain to zero once all
    // games and users are gone.
    if (typeof (this.pingInterval as any).unref === 'function') {
      (this.pingInterval as any).unref();
    }
    console.log('[ActiveGameManager] Server ping interval started (30s, unref\'d)');
  }

  registerGame(gameState: GameState): void {
    const gameId = gameState.game.id;
    const snakeId = gameState.you.id;

    let game = this.games.get(gameId);
    if (!game) {
      const now = Date.now();
      game = {
        gameId,
        boardState: gameState,
        boardStateTurn: gameState.turn || 0,
        snakes: new Map(),
        controlledSnakes: new Map(),
        connectedUsers: new Map(),
        gameTimeout: gameState.game.timeout || 500,
        startedAt: now,
        lastActivityAt: now,
        colorPool: [...DISTINCT_COLORS],
        userColors: new Map(),
        colorReleaseTimers: new Map(),
        turnExpiryTime: null,
        currentTurn: gameState.turn || 0,
        commitBufferMs: DEFAULT_COMMIT_BUFFER_MS,
        effectiveCommitBufferMs: DEFAULT_COMMIT_BUFFER_MS,
      };
      this.games.set(gameId, game);
    }

    for (const snake of gameState.board.snakes) {
      if (!game.snakes.has(snake.id)) {
        game.snakes.set(snake.id, {
          id: snake.id,
          name: snake.name,
          emoji: snake.emoji || '',
        });
      }
    }

    if (!game.controlledSnakes.has(snakeId)) {
      console.log(`[ActiveGameManager] Registering controlled snake: ${gameId}:${snakeId} (${gameState.you.name})`);
      game.controlledSnakes.set(snakeId, {
        id: snakeId,
        name: gameState.you.name,
        emoji: gameState.you.emoji || '',
        pendingMove: null,
        latestTurnData: null,
        botRecommendation: null,
        selectedBy: null,
        moveCommittedThisTurn: false,
        committedMove: null,
        holdTurnsRemaining: 0,
        suicideArmed: false,
        intent: { kind: 'heuristic' },
        staged: null,
        fatalPromptTurn: null,
        fatalPromptMove: null,
      });
      this.notifyGameListChange('added', gameId, snakeId);
    }
  }

  endGame(gameId: string, snakeId: string, finalGameState?: GameState): void {
    const game = this.games.get(gameId);
    if (!game) {
      console.log(`[ActiveGameManager] endGame called for unknown game: ${gameId}:${snakeId}`);
      return;
    }

    const controlled = game.controlledSnakes.get(snakeId);
    if (!controlled) {
      // Duplicate /end for a snake we've already cleaned up. Don't re-fire
      // events that would bounce the UI; just no-op.
      console.log(`[ActiveGameManager] endGame for already-removed snake ${gameId}:${snakeId}, ignoring`);
      return;
    }
    if (controlled.pendingMove && !controlled.pendingMove.resolved) {
      this.resolvePendingMove(gameId, snakeId, controlled.pendingMove.botMove || 'up', 'game-end');
    }

    // The /end payload from the engine carries the actual final game state,
    // which is typically several turns ahead of our last /move (because other
    // snakes kept playing after ours died, and the death-state turn itself
    // never came in via /move). Push it through the normal board-update
    // pipeline so the centaur paints the real final position instead of
    // freezing on whatever turn our snake last responded to.
    let acceptedFinalState = false;
    const incomingTurn = finalGameState?.turn ?? -1;
    if (finalGameState && incomingTurn >= game.boardStateTurn) {
      game.boardState = finalGameState;
      game.boardStateTurn = incomingTurn;
      game.currentTurn = Math.max(game.currentTurn, incomingTurn);
      game.lastActivityAt = Date.now();
      this.notifyBoardUpdate(gameId, finalGameState);
      acceptedFinalState = true;
    } else if (finalGameState) {
      console.log(`[ActiveGameManager] endGame final-state for ${gameId}:${snakeId} rejected as stale (incomingTurn=${incomingTurn} < boardStateTurn=${game.boardStateTurn})`);
    }

    game.controlledSnakes.delete(snakeId);
    this.notifyGameListChange('removed', gameId, snakeId);

    const gameOver = game.controlledSnakes.size === 0;
    console.log(
      `[ActiveGameManager] endGame ${gameId}:${snakeId} processed — acceptedFinalState=${acceptedFinalState}, controlledSnakesRemaining=${game.controlledSnakes.size}, gameOver=${gameOver}`,
    );
    // Only emit snake-ended when the final state is fresh enough to apply.
    // A stale /end shouldn't rewind the UI's rendered turn.
    if (finalGameState && acceptedFinalState) {
      this.notifyGameEnd(gameId, snakeId, finalGameState, gameOver);
    }

    if (gameOver) {
      console.log(`[ActiveGameManager] All controlled snakes ended for game ${gameId}, removing game`);
      this.clearColorReleaseTimers(game);
      this.games.delete(gameId);
      this.logIfFullyIdle();
    }
  }

  isSnakeSelected(gameId: string, snakeId: string): boolean {
    const game = this.games.get(gameId);
    if (!game) return false;
    const controlled = game.controlledSnakes.get(snakeId);
    return controlled?.selectedBy !== null && controlled?.selectedBy !== undefined;
  }

  selectSnake(gameId: string, snakeId: string, userId: string, force: boolean = false): { success: boolean; contestedBy?: string; revokedUserId?: string } {
    const game = this.games.get(gameId);
    if (!game) return { success: false };

    const controlled = game.controlledSnakes.get(snakeId);
    if (!controlled) return { success: false };

    const user = game.connectedUsers.get(userId);
    if (!user) return { success: false };

    if (user.selectedSnakeId && user.selectedSnakeId !== snakeId) {
      this.deselectSnake(gameId, userId);
    }

    if (controlled.selectedBy && controlled.selectedBy !== userId) {
      if (!force) {
        return { success: false, contestedBy: controlled.selectedBy };
      }
      const previousUserId = controlled.selectedBy;
      const previousUser = game.connectedUsers.get(previousUserId);
      if (previousUser) {
        previousUser.selectedSnakeId = null;
      }
      controlled.selectedBy = userId;
      user.selectedSnakeId = snakeId;
      return { success: true, revokedUserId: previousUserId };
    }

    controlled.selectedBy = userId;
    user.selectedSnakeId = snakeId;
    return { success: true };
  }

  holdSnake(gameId: string, snakeId: string, userId: string): { success: boolean; holdTurnsRemaining: number } {
    const game = this.games.get(gameId);
    if (!game) return { success: false, holdTurnsRemaining: 0 };

    const controlled = game.controlledSnakes.get(snakeId);
    if (!controlled) return { success: false, holdTurnsRemaining: 0 };

    if (controlled.selectedBy && controlled.selectedBy !== userId) {
      return { success: false, holdTurnsRemaining: controlled.holdTurnsRemaining };
    }

    controlled.holdTurnsRemaining += 1;
    console.log(`[ActiveGameManager] Hold added for ${gameId}:${snakeId} by ${userId}: now holding ${controlled.holdTurnsRemaining} turn(s)`);

    // Hold defers the commit to the deadline and drops any manual staging so the
    // snake reverts to its bot move (queue/waypoint persist). Re-stage, or the
    // deadline commit and broadcast arrow keep showing the cleared manual move.
    if (controlled.intent.kind === 'manual') {
      this.setIntent(gameId, snakeId, { kind: 'heuristic' });
    } else {
      this.stageMove(gameId, snakeId);
    }

    if (!controlled.selectedBy) {
      const user = game.connectedUsers.get(userId);
      if (user) {
        if (user.selectedSnakeId && user.selectedSnakeId !== snakeId) {
          this.deselectSnake(gameId, userId);
        }
        controlled.selectedBy = userId;
        user.selectedSnakeId = snakeId;
      }
    }

    return { success: true, holdTurnsRemaining: controlled.holdTurnsRemaining };
  }

  releaseAllHolds(gameId: string): { released: string[] } {
    const game = this.games.get(gameId);
    if (!game) return { released: [] };

    // Releasing a hold ONLY clears the hold flag. It must not commit anything:
    // the per-snake deadline safety timer remains the sole commit path (the
    // armed-suicide kill is the one exception). Each released snake's pending
    // move still commits its staged move when its timer fires.
    const released: string[] = [];
    for (const [snakeId, controlled] of game.controlledSnakes) {
      if (controlled.holdTurnsRemaining > 0) {
        controlled.holdTurnsRemaining = 0;
        released.push(snakeId);
      }
    }
    if (released.length > 0) {
      console.log(`[ActiveGameManager] Released holds for game ${gameId}: ${released.join(', ')}`);
    }
    return { released };
  }

  suicideAllSnakes(gameId: string): { affected: string[] } {
    const game = this.games.get(gameId);
    if (!game) return { affected: [] };

    const affected: string[] = [];
    for (const [snakeId, controlled] of game.controlledSnakes) {
      controlled.suicideArmed = true;
      controlled.holdTurnsRemaining = 0;
      affected.push(snakeId);

      if (controlled.pendingMove && !controlled.pendingMove.resolved && controlled.pendingMove.turnData) {
        const move = computeSuicideMove(controlled.pendingMove.turnData.gameState);
        console.log(`[ActiveGameManager] SUICIDE: immediately submitting ${move} for ${gameId}:${snakeId}`);
        controlled.suicideArmed = false;
        // Kill-all is the second fatal-consent mint point: stage the suicide
        // move WITH consent so it flows through the single staged-move writer
        // (and its gate) instead of bypassing it, then commit it immediately.
        this.setIntent(gameId, snakeId, { kind: 'manual', move, fatalConsent: mintFatalMoveConsent() });
        this.resolvePendingMove(gameId, snakeId, controlled.staged?.move ?? move, 'suicide');
      }
    }
    if (affected.length > 0) {
      console.log(`[ActiveGameManager] SUICIDE armed for game ${gameId}: ${affected.join(', ')}`);
    }
    return { affected };
  }

  // Immediately commit the currently staged move for every controlled snake
  // with an unresolved pending move, ending the wait for the per-snake safety
  // timer. Mirrors the deadline commit path (reads the already-current
  // stagedMove — no recomputation). Snakes that already committed this turn or
  // have no pending move are left untouched.
  commitAllStaged(gameId: string): { affected: string[] } {
    const game = this.games.get(gameId);
    if (!game) return { affected: [] };

    const affected: string[] = [];
    for (const [snakeId, controlled] of game.controlledSnakes) {
      if (controlled.pendingMove && !controlled.pendingMove.resolved) {
        const move = this.commitStagedMove(gameId, snakeId, controlled.pendingMove.turn, 'commit-all');
        console.log(`[ActiveGameManager] COMMIT-ALL: submitting ${move} for ${gameId}:${snakeId} turn ${controlled.pendingMove.turn}`);
        this.resolvePendingMove(gameId, snakeId, move, 'commit-all');
        affected.push(snakeId);
      }
    }
    if (affected.length > 0) {
      console.log(`[ActiveGameManager] COMMIT-ALL for game ${gameId}: ${affected.join(', ')}`);
    }
    return { affected };
  }

  getHoldStates(gameId: string): { [snakeId: string]: number } {
    const game = this.games.get(gameId);
    if (!game) return {};
    const out: { [snakeId: string]: number } = {};
    for (const [snakeId, cs] of game.controlledSnakes) {
      out[snakeId] = cs.holdTurnsRemaining;
    }
    return out;
  }

  deselectSnake(gameId: string, userId: string): void {
    const game = this.games.get(gameId);
    if (!game) return;

    const user = game.connectedUsers.get(userId);
    if (!user || !user.selectedSnakeId) return;

    const snakeId = user.selectedSnakeId;
    const controlled = game.controlledSnakes.get(snakeId);
    if (controlled && controlled.selectedBy === userId) {
      controlled.selectedBy = null;

      if (controlled.pendingMove && !controlled.pendingMove.resolved) {
        const staged = controlled.intent.kind === 'manual' ? controlled.intent.move : null;
        console.log(`[ActiveGameManager] Snake deselected ${gameId}:${snakeId} (turn ${game.currentTurn}), staged move=${staged || 'none'} — waiting for safety timer or reselection`);
      }
    }
    user.selectedSnakeId = null;
  }

  addConnectedUser(gameId: string, userId: string): ConnectedUser | null {
    const game = this.games.get(gameId);
    if (!game) return null;

    if (game.connectedUsers.has(userId)) {
      return game.connectedUsers.get(userId)!;
    }

    // A reconnect within the grace window: cancel the pending colour release so
    // the colour is never returned to the pool — the user reclaims it exactly.
    const pendingRelease = game.colorReleaseTimers.get(userId);
    if (pendingRelease) {
      clearTimeout(pendingRelease);
      game.colorReleaseTimers.delete(userId);
    }

    // Reuse the user's previously assigned colour if we still remember it
    // (reconnect, possibly after the timer was cancelled above); otherwise pull
    // a fresh one from the pool.
    let color = game.userColors.get(userId);
    if (!color) {
      color = game.colorPool.length > 0
        ? game.colorPool.shift()!
        : DISTINCT_COLORS[game.connectedUsers.size % DISTINCT_COLORS.length];
      game.userColors.set(userId, color);
    }

    const user: ConnectedUser = {
      userId,
      color,
      selectedSnakeId: null,
      nickname: null,
    };
    game.connectedUsers.set(userId, user);
    return user;
  }

  setUserNickname(gameId: string, userId: string, nickname: string | null): boolean {
    const game = this.games.get(gameId);
    if (!game) return false;
    const user = game.connectedUsers.get(userId);
    if (!user) return false;
    user.nickname = nickname && nickname.trim().length > 0 ? nickname.trim().substring(0, 20) : null;
    return true;
  }

  removeConnectedUser(gameId: string, userId: string): void {
    const game = this.games.get(gameId);
    if (!game) return;

    const user = game.connectedUsers.get(userId);
    if (!user) return;

    if (user.selectedSnakeId) {
      const controlled = game.controlledSnakes.get(user.selectedSnakeId);
      if (controlled && controlled.selectedBy === userId) {
        controlled.selectedBy = null;
      }
    }

    game.connectedUsers.delete(userId);

    // Don't recycle the colour immediately. Hold it in reserve (userColors keeps
    // the association) so a quick reconnect reclaims the exact same colour with
    // no churn. Only after the grace window expires with no reconnect do we
    // return it to the pool. Replace any existing timer (defensive — shouldn't
    // happen since a reconnect cancels it).
    const existing = game.colorReleaseTimers.get(userId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      const g = this.games.get(gameId);
      if (!g) return;
      g.colorReleaseTimers.delete(userId);
      // If the user reconnected in the meantime, leave their colour alone.
      if (g.connectedUsers.has(userId)) return;
      const color = g.userColors.get(userId);
      if (color) {
        g.colorPool.push(color);
        g.userColors.delete(userId);
      }
    }, COLOR_RELEASE_GRACE_MS);
    if (typeof (timer as any).unref === 'function') (timer as any).unref();
    game.colorReleaseTimers.set(userId, timer);
  }

  /** Cancel all pending colour-release timers for a game. Call before deleting a
   *  game so a stale timer can't fire against a removed game. */
  private clearColorReleaseTimers(game: ActiveGame): void {
    for (const timer of game.colorReleaseTimers.values()) {
      clearTimeout(timer);
    }
    game.colorReleaseTimers.clear();
  }

  getGame(gameId: string): ActiveGame | undefined {
    return this.games.get(gameId);
  }

  getActiveGames(): Array<{
    gameId: string;
    controlledSnakes: Array<{ id: string; name: string; emoji: string }>;
    turn: number;
    gameState: GameState | null;
    startedAt: number;
  }> {
    const result: Array<any> = [];
    for (const game of this.games.values()) {
      const snakes: Array<{ id: string; name: string; emoji: string }> = [];
      for (const cs of game.controlledSnakes.values()) {
        snakes.push({ id: cs.id, name: cs.name, emoji: cs.emoji });
      }
      result.push({
        gameId: game.gameId,
        controlledSnakes: snakes,
        turn: game.currentTurn,
        gameState: game.boardState,
        startedAt: game.startedAt,
      });
    }
    return result;
  }

  getGameState(gameId: string): {
    boardState: BoardSnapshot | null;
    controlledSnakes: Array<{
      id: string; name: string; emoji: string;
      selectedBy: string | null;
      moveCommittedThisTurn: boolean;
      committedMove: Direction | null;
      turnData: TurnData | null;
      botRecommendation: Direction | null;
    }>;
    connectedUsers: Array<ConnectedUser>;
    selections: { [snakeId: string]: { userId: string; color: string } | null };
    holds: { [snakeId: string]: number };
    premoves: { [snakeId: string]: Coord[] };
    waypoints: { [snakeId: string]: { type: 'green' | 'blue'; x: number; y: number } };
    gameTimeout: number;
    turnExpiryTime: number | null;
    measuredPing: number;
    commitBufferMs: number;
    effectiveCommitBufferMs: number;
  } | null {
    const game = this.games.get(gameId);
    if (!game) return null;

    const controlledSnakes: Array<{
      id: string; name: string; emoji: string;
      selectedBy: string | null;
      moveCommittedThisTurn: boolean;
      committedMove: Direction | null;
      turnData: TurnData | null;
      botRecommendation: Direction | null;
    }> = [];
    const selections: { [snakeId: string]: { userId: string; color: string } | null } = {};

    for (const cs of game.controlledSnakes.values()) {
      controlledSnakes.push({
        id: cs.id,
        name: cs.name,
        emoji: cs.emoji,
        selectedBy: cs.selectedBy,
        moveCommittedThisTurn: cs.moveCommittedThisTurn,
        committedMove: cs.committedMove,
        turnData: cs.latestTurnData,
        botRecommendation: cs.botRecommendation,
      });
      if (cs.selectedBy) {
        const user = game.connectedUsers.get(cs.selectedBy);
        selections[cs.id] = {
          userId: cs.selectedBy,
          color: user?.color || '#888888',
        };
      } else {
        selections[cs.id] = null;
      }
    }

    const holds: { [snakeId: string]: number } = {};
    for (const [snakeId, cs] of game.controlledSnakes) {
      holds[snakeId] = cs.holdTurnsRemaining;
    }

    return {
      boardState: game.boardState,
      controlledSnakes,
      connectedUsers: Array.from(game.connectedUsers.values()),
      selections,
      holds,
      premoves: this.getPremovesForGame(gameId),
      waypoints: this.getWaypointsForGame(gameId),
      gameTimeout: game.gameTimeout,
      turnExpiryTime: game.turnExpiryTime,
      measuredPing: this.gameServerPing,
      commitBufferMs: game.commitBufferMs,
      effectiveCommitBufferMs: game.effectiveCommitBufferMs,
    };
  }

  getCommitBuffer(gameId: string): number {
    return this.games.get(gameId)?.commitBufferMs ?? DEFAULT_COMMIT_BUFFER_MS;
  }

  getEffectiveCommitBuffer(gameId: string): number {
    return this.games.get(gameId)?.effectiveCommitBufferMs ?? DEFAULT_COMMIT_BUFFER_MS;
  }

  setCommitBuffer(gameId: string, bufferMs: number): number | null {
    const game = this.games.get(gameId);
    if (!game) return null;
    const clamped = Math.round(
      Math.min(MAX_COMMIT_BUFFER_MS, Math.max(MIN_COMMIT_BUFFER_MS, Number(bufferMs) || DEFAULT_COMMIT_BUFFER_MS))
    );
    game.commitBufferMs = clamped;
    console.log(`[ActiveGameManager] Commit buffer for ${gameId} set to ${clamped}ms`);
    return clamped;
  }

  getWaypoint(gameId: string, snakeId: string): { type: 'green' | 'blue'; x: number; y: number } | null {
    const game = this.games.get(gameId);
    if (!game) return null;
    const controlled = game.controlledSnakes.get(snakeId);
    if (controlled?.intent.kind !== 'waypoint') return null;
    return { type: controlled.intent.style, x: controlled.intent.target.x, y: controlled.intent.target.y };
  }

  getWaypointsForGame(gameId: string): { [snakeId: string]: { type: 'green' | 'blue'; x: number; y: number } } {
    const game = this.games.get(gameId);
    if (!game) return {};
    const result: { [snakeId: string]: { type: 'green' | 'blue'; x: number; y: number } } = {};
    for (const [snakeId, cs] of game.controlledSnakes) {
      if (cs.intent.kind === 'waypoint') {
        result[snakeId] = { type: cs.intent.style, x: cs.intent.target.x, y: cs.intent.target.y };
      }
    }
    return result;
  }

  // Set or clear a snake's waypoint. Only the user currently selecting the
  // snake may change it. Pass `waypoint=null` to clear. Returns true on success.
  setWaypoint(
    gameId: string,
    snakeId: string,
    waypoint: { type: 'green' | 'blue'; x: number; y: number } | null,
    userId: string
  ): boolean {
    const game = this.games.get(gameId);
    if (!game) return false;
    const controlled = game.controlledSnakes.get(snakeId);
    if (!controlled) return false;
    if (controlled.selectedBy !== userId) return false;

    if (waypoint === null) {
      // Clearing only applies while in waypoint mode; otherwise leave the
      // current intent (queue/manual/heuristic) untouched and just re-stage.
      if (controlled.intent.kind === 'waypoint') {
        this.setIntent(gameId, snakeId, { kind: 'heuristic' });
      } else {
        this.stageMove(gameId, snakeId);
      }
      return true;
    }

    const board = game.boardState?.board;
    const w = board?.width ?? 0;
    const h = board?.height ?? 0;
    const x = Math.floor(Number(waypoint.x));
    const y = Math.floor(Number(waypoint.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (w > 0 && (x < 0 || x >= w)) return false;
    if (h > 0 && (y < 0 || y >= h)) return false;
    if (waypoint.type !== 'green' && waypoint.type !== 'blue') return false;

    // Compute the green goto route now so the path renders immediately rather
    // than only after the next /move. Build a GameState whose `you` is THIS
    // snake so BoardGraph applies the right invulnerability/severability rules
    // (boardState.you is whichever snake last sent /move, which may differ).
    const route = this.computeGotoRouteNow(
      game.boardState,
      snakeId,
      { type: waypoint.type, x, y },
      this.getProjectedHead(gameId, snakeId) ?? undefined
    );
    // Setting a waypoint activates Waypoint mode (replacing queue/manual).
    this.setIntent(gameId, snakeId, { kind: 'waypoint', style: waypoint.type, target: { x, y }, route });
    return true;
  }

  // The shared `game.boardState` is a BoardSnapshot with NO `you` — a single
  // shared board cannot have a meaningful "our snake" while many snakes are
  // controlled at once. Any perspective-dependent logic (BoardGraph
  // invulnerability/severability, route finding) MUST obtain a per-snake
  // GameState through this helper, which re-points `you` to the requested snake
  // by ID. Returns null when the snake isn't on the board. This is the only
  // sanctioned way to turn the shared snapshot into a GameState; reading `.you`
  // off the snapshot directly is a compile error by design.
  private viewFor(snapshot: BoardSnapshot, snakeId: string): GameState | null {
    const you = snapshot.board.snakes.find(s => s.id === snakeId);
    if (!you) return null;
    return { ...snapshot, you };
  }

  // Synchronously compute the green goto route from the latest shared board
  // state. Returns [] for blue/null waypoints or when there's no board state.
  private computeGotoRouteNow(
    boardState: BoardSnapshot | null,
    snakeId: string,
    waypoint: { type: 'green' | 'blue'; x: number; y: number } | null,
    startHead?: Coord
  ): Coord[] {
    if (!boardState || !waypoint || waypoint.type !== 'green') return [];
    const gsForRoute = this.viewFor(boardState, snakeId);
    if (!gsForRoute) return [];
    return this.routeEvaluator.computeWaypointRoute(gsForRoute, snakeId, waypoint, startHead);
  }

  // Recompute and store the green goto route anchored at the snake's projected
  // head (the cell it will occupy after any move already committed this turn).
  // No-op unless the snake is actively in waypoint mode with a green waypoint.
  private recomputeGotoRoute(gameId: string, snakeId: string): void {
    const game = this.games.get(gameId);
    const controlled = game?.controlledSnakes.get(snakeId);
    if (!game || !controlled) return;
    if (controlled.intent.kind !== 'waypoint') return;
    controlled.intent.route = this.computeGotoRouteNow(
      game.boardState,
      snakeId,
      { type: controlled.intent.style, x: controlled.intent.target.x, y: controlled.intent.target.y },
      this.getProjectedHead(gameId, snakeId) ?? undefined
    );
  }

  getPremovesForGame(gameId: string): { [snakeId: string]: Coord[] } {
    const game = this.games.get(gameId);
    if (!game) return {};
    const result: { [snakeId: string]: Coord[] } = {};
    for (const [snakeId, cs] of game.controlledSnakes) {
      if (cs.intent.kind === 'queue' && cs.intent.cells.length > 0) {
        result[snakeId] = cs.intent.cells;
      }
    }
    return result;
  }

  // The cell the snake's head will occupy after the move it has already
  // committed this turn. If no move is committed yet, this is just the
  // current head. Anchors all "next turn" rendering: Q-mode adjacency,
  // candidate-arrow cells, queue-extension click targets.
  getProjectedHead(gameId: string, snakeId: string): Coord | null {
    const game = this.games.get(gameId);
    if (!game?.boardState) return null;
    const controlled = game.controlledSnakes.get(snakeId);
    if (!controlled) return null;
    const snake = game.boardState.board.snakes.find(s => s.id === snakeId);
    const head = snake?.head || snake?.body?.[0];
    if (!head) return null;
    if (controlled.moveCommittedThisTurn && controlled.committedMove) {
      switch (controlled.committedMove) {
        case 'up':    return { x: head.x,     y: head.y + 1 };
        case 'down':  return { x: head.x,     y: head.y - 1 };
        case 'left':  return { x: head.x - 1, y: head.y     };
        case 'right': return { x: head.x + 1, y: head.y     };
      }
    }
    return head;
  }

  private static destinationOf(head: Coord, move: Direction): Coord {
    switch (move) {
      case 'up':    return { x: head.x,     y: head.y + 1 };
      case 'down':  return { x: head.x,     y: head.y - 1 };
      case 'left':  return { x: head.x - 1, y: head.y     };
      case 'right': return { x: head.x + 1, y: head.y     };
    }
  }

  // Non-mutating safety probe. Reports whether `move` would put THIS snake's
  // head on an impassable cell next turn — off-board, wall/hazard, our own
  // body, or a non-severable enemy body — evaluated from the committing snake's
  // OWN perspective via passabilityFor(snakeId), so an invulnerable snake
  // attacking a weaker enemy is correctly NOT fatal. Uses optimistic turn-1
  // semantics, the same the goto-route and space BFS use, so a step onto a tail
  // that vacates this turn is not flagged.
  //
  // This NEVER changes the committed move. The staged move is sacrosanct and
  // commits verbatim; this exists solely so the UI can warn a human that the
  // move they staged is certain death.
  private isMoveFatal(gameId: string, snakeId: string, move: Direction): boolean {
    const game = this.games.get(gameId);
    // After /end the stored boardState can be a final payload with no `board`
    // (scores/winners only), so a UI staged-move hint has nothing to evaluate.
    if (!game?.boardState?.board?.snakes) return false;
    const snake = game.boardState.board.snakes.find(s => s.id === snakeId);
    const head = snake?.head || snake?.body?.[0];
    if (!head) return false;
    try {
      const dest = ActiveGameManager.destinationOf(head, move);

      // Own-tail refinement: if the staged move steps onto our OWN tail and
      // that cell has no food, then by definition we are NOT eating this turn,
      // so no speculative "could eat" may keep the tail in place. The tail
      // vacates unless the snake just ate (head already on food) — or, under
      // grow-next-turn, the body is too short for the tail to move. The tail
      // cell must be uniquely the tail (not stacked under an interior segment
      // from a just-completed growth) for this shortcut to apply.
      const body = snake?.body || [];
      const tail = body[body.length - 1];
      const isOwnTail = !!tail && dest.x === tail.x && dest.y === tail.y && body.length > 2;
      const tailStacked = isOwnTail &&
        body.slice(1, -1).some(seg => seg.x === tail.x && seg.y === tail.y);
      const food = game.boardState.board.food || [];
      const destHasFood = food.some(f => f.x === dest.x && f.y === dest.y);
      if (isOwnTail && !tailStacked && !destHasFood) {
        const justAte = food.some(f => f.x === head.x && f.y === head.y);
        return justAte;
      }

      const graph = new BoardGraph(game.boardState);
      return !graph.passabilityFor(snakeId, { clearance: 'optimistic' }).passable(dest, 1);
    } catch (e) {
      // A UI hint must never throw on the broadcast path — treat as not-fatal.
      console.error(`[ActiveGameManager] isMoveFatal failed for ${gameId}:${snakeId}:`, e);
      return false;
    }
  }

  // Public: is the move this snake will actually commit this turn (the committed
  // move if one is already locked in, else the current staged move) certain
  // death? Drives the red "fatal staged move" marker in the centaur UI. Pure
  // read — no mutation, no effect on what commits.
  isStagedMoveFatal(gameId: string, snakeId: string): boolean {
    const game = this.games.get(gameId);
    const controlled = game?.controlledSnakes.get(snakeId);
    if (!controlled) return false;
    const move = (controlled.moveCommittedThisTurn && controlled.committedMove)
      ? controlled.committedMove
      : controlled.staged?.move;
    if (!move) return false;
    return this.isMoveFatal(gameId, snakeId, move);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Derives "what move this snake intends this turn" from the active intent
  // method. This is NOT read at commit time — stageMove runs it once per input
  // change and binds the result into `staged`, which is the single record the
  // safety-timer commit and the staged-arrow broadcast read.
  //
  // Priority follows the snake's intention (a single discriminated union, so
  // only one of manual/queue/waypoint can be populated at once):
  //   1. manual user selection (this turn)
  //   2. queue head (adjacent to current head)
  //   3. goto route head (first step of the rendered green waypoint route)
  //   4. bot recommendation
  //   5. hard fallback ('up')
  // ────────────────────────────────────────────────────────────────────────
  computeIntendedMove(gameId: string, snakeId: string): IntendedMove {
    const game = this.games.get(gameId);
    const controlled = game?.controlledSnakes.get(snakeId);
    const intent = controlled?.intent;

    if (intent?.kind === 'manual') {
      return { direction: intent.move, source: 'manual', consent: intent.fatalConsent };
    }

    if (intent?.kind === 'queue') {
      const premoveDir = this.getPremoveDirection(gameId, snakeId);
      if (premoveDir) {
        return { direction: premoveDir, source: 'queue' };
      }
    }

    // Waypoint mode HARD-OVERRIDES the move with the first step of the exact
    // route drawn on the board (computed by the same pathfinder). This makes
    // the affordance, the green visual, and the committed move one mechanism:
    // the snake always walks the path it shows.
    if (intent?.kind === 'waypoint') {
      const gotoDir = this.getGotoRouteDirection(gameId, snakeId);
      if (gotoDir) {
        return { direction: gotoDir, source: 'waypoint' };
      }
    }

    if (controlled?.botRecommendation) {
      // Anything that reaches here is the bot's recommendation — manual, queue,
      // and the goto-route head were all unavailable this turn. Report it
      // truthfully as 'bot' even when a waypoint/queue is nominally set, so the
      // staged arrow renders grey and the user can never mistake a bot decision
      // for their own staged move (the disguised-'waypoint' label was Bug A).
      // The route/queue/manual fallback is logged at the stageMove choke
      // point where the active intent mode is known.
      return { direction: controlled.botRecommendation, source: 'bot' };
    }

    return { direction: 'up', source: 'fallback' };
  }

  // Returns the move direction for the first step of the snake's live goto
  // route (the rendered green path), or null when waypoint mode isn't active,
  // the route is empty, or its head isn't adjacent to the anchor (stale route /
  // divergence — caller falls back to the biased bot recommendation).
  //
  // The route is anchored at the PROJECTED head (recomputeGotoRoute /
  // computeGotoRouteNow both pass getProjectedHead as startHead), so the first
  // step MUST be measured from that same projected head — not the live head.
  // Pre-commit projected head == live head, so this is identical in the common
  // case; it only differs after a move is already committed this turn, which is
  // exactly when measuring from the live head returned null and silently
  // abandoned the green route the snake was displaying.
  private getGotoRouteDirection(gameId: string, snakeId: string): Direction | null {
    const game = this.games.get(gameId);
    if (!game?.boardState) return null;
    const controlled = game.controlledSnakes.get(snakeId);
    if (!controlled || controlled.intent.kind !== 'waypoint') return null;
    if (controlled.intent.route.length === 0) return null;
    const anchor = this.getProjectedHead(gameId, snakeId);
    if (!anchor) return null;
    const target = controlled.intent.route[0];
    if (this.isStepBehindAnchor(gameId, snakeId, target)) {
      console.warn(`[ActiveGameManager] Stale goto route for ${gameId}:${snakeId}: first cell (${target.x},${target.y}) is the just-vacated neck — refusing 180° reversal, falling back to bot`);
      return null;
    }
    return ActiveGameManager.directionFromTo(anchor, target);
  }

  // The cell the snake occupied immediately BEFORE the anchor cell that queue
  // and goto-route steps are measured from. Stepping onto this cell is by
  // definition a 180° reversal into the snake's own just-vacated neck (certain
  // death by the game rules), so it can never be a valid queue/route step —
  // adjacency alone is NOT sufficient validity.
  //  - No move committed this turn → anchor is the live head; behind = body[1].
  //  - Move already committed      → anchor is the projected head; behind = live head.
  private cellBehindAnchor(gameId: string, snakeId: string): Coord | null {
    const game = this.games.get(gameId);
    const controlled = game?.controlledSnakes.get(snakeId);
    if (!game?.boardState?.board?.snakes || !controlled) return null;
    const snake = game.boardState.board.snakes.find(s => s.id === snakeId);
    const head = snake?.head || snake?.body?.[0];
    if (!head) return null;
    if (controlled.moveCommittedThisTurn && controlled.committedMove) {
      return head;
    }
    const neck = snake?.body?.[1];
    if (neck && (neck.x !== head.x || neck.y !== head.y)) {
      return neck;
    }
    return null;
  }

  private isStepBehindAnchor(gameId: string, snakeId: string, target: Coord): boolean {
    const behind = this.cellBehindAnchor(gameId, snakeId);
    return !!behind && behind.x === target.x && behind.y === target.y;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Single write point for a snake's intention. Replacing the union as a whole
  // is the mutual exclusion: the new intent structurally supersedes whatever
  // queue/waypoint/manual state the old one held — no field-by-field clearing.
  // Always re-stages the move so `staged` and the broadcast arrow track it.
  private setIntent(gameId: string, snakeId: string, intent: SnakeIntent): void {
    const controlled = this.games.get(gameId)?.controlledSnakes.get(snakeId);
    if (!controlled) return;
    const previous = controlled.intent;
    if (previous.kind === 'manual' && intent.kind !== 'manual') {
      // A still-staged manual selection is being dropped before it committed
      // (e.g. the user set a queue/waypoint, or a hold reverted to the bot).
      // Log it so a manual move never silently disappears mid-turn.
      console.log(`[ActiveGameManager] Manual selection ${previous.move} for ${gameId}:${snakeId} cleared (intent → ${intent.kind})`);
    }
    controlled.intent = intent;
    this.stageMove(gameId, snakeId);
  }

  // The sole writer of `staged`: resolves the active intent to one Direction via
  // computeIntendedMove and binds it to the current (snakeId, turn) as one atomic
  // record. Call on every input change (turn start, intent-mode switch, queue or
  // waypoint set, manual selection, bot completion while heuristic). The deadline
  // commit and the staged-arrow broadcast only ever read `staged`.
  private stageMove(gameId: string, snakeId: string): void {
    const game = this.games.get(gameId);
    const controlled = game?.controlledSnakes.get(snakeId);
    if (!controlled) return;
    const previous = controlled.staged;
    const intended = this.computeIntendedMove(gameId, snakeId);
    const turn = game!.boardStateTurn;

    // ── Fatal-move consent gate ─────────────────────────────────────────
    // A HUMAN-sourced certain-death move (manual click, queue step, waypoint
    // step) may only be staged when it carries a minted FatalMoveConsent.
    // Without consent we stage the bot's move instead and ask the client to
    // show a confirmation dialog. Bot-sourced moves are exempt: when the bot
    // itself picks a fatal move there is no better alternative to offer.
    let direction = intended.direction;
    let source = intended.source;
    const humanSourced = source === 'manual' || source === 'queue' || source === 'waypoint';
    if (humanSourced && !intended.consent && this.isMoveFatal(gameId, snakeId, direction)) {
      const fallback = controlled.botRecommendation;
      console.warn(`[ActiveGameManager] FATAL-MOVE GATE for ${gameId}:${snakeId} turn ${turn}: unconsented ${source} move ${direction} is certain death — staging ${fallback ? `bot move ${fallback}` : `fallback 'up'`} instead, awaiting confirmation`);
      if (controlled.fatalPromptTurn !== turn || controlled.fatalPromptMove !== direction) {
        controlled.fatalPromptTurn = turn;
        controlled.fatalPromptMove = direction;
        this.notifyFatalConfirmationNeeded(gameId, snakeId, direction, turn);
      }
      if (fallback) {
        direction = fallback;
        source = 'bot';
      } else {
        direction = 'up';
        source = 'fallback';
      }
    }

    controlled.staged = {
      snakeId,
      turn,
      move: direction,
      source,
      // Consent only counts when the consented move is the one actually staged
      // (the gate above may have replaced it with the bot fallback).
      fatalConsented: !!intended.consent && direction === intended.direction,
    };
    this.logReversalTripwire(gameId, controlled, direction, source);
    this.logStagedMoveAnomalies(gameId, controlled, previous, intended);
    // Reactive sync: every stage (the single point all intent changes funnel
    // through) marks the game dirty so the staged arrow + intent projections
    // are pushed to clients, coalesced to once per event-loop tick.
    this.notifyStagedChange(gameId);
  }

  // Permanent tripwire: a staged move whose destination is the snake's own
  // neck (the just-vacated cell) is a guaranteed 180° self-collision. This
  // should now be impossible for human-sourced moves (consent gate + neck
  // guards), so any hit is a bug worth a full state dump — or a deliberate
  // kill-all. Log-only; never alters the staged move.
  private logReversalTripwire(gameId: string, controlled: ControlledSnake, move: Direction, source: IntendedMoveSource): void {
    const game = this.games.get(gameId);
    const snake = game?.boardState?.board?.snakes?.find(s => s.id === controlled.id);
    const head = snake?.head || snake?.body?.[0];
    const neck = snake?.body?.[1];
    if (!head || !neck || (neck.x === head.x && neck.y === head.y)) return;
    const dest = ActiveGameManager.destinationOf(head, move);
    if (dest.x !== neck.x || dest.y !== neck.y) return;
    console.warn(`[ActiveGameManager] REVERSAL TRIPWIRE for ${gameId}:${controlled.id}: staged ${source} move ${move} steps onto own neck. State: ${JSON.stringify({
      turn: game?.boardStateTurn,
      move,
      source,
      head,
      neck,
      projectedHead: this.getProjectedHead(gameId, controlled.id),
      moveCommittedThisTurn: controlled.moveCommittedThisTurn,
      committedMove: controlled.committedMove,
      intent: controlled.intent,
      staged: controlled.staged,
      suicideArmed: controlled.suicideArmed,
    })}`);
  }

  // Surfaces the two previously-silent failure modes whenever a move is staged:
  // a human intent that silently fell back to the bot's move, and a manual
  // selection that changed direction or origin within the same turn.
  private logStagedMoveAnomalies(gameId: string, controlled: ControlledSnake, previous: StagedMove | null, intended: IntendedMove): void {
    const resolvedToBot = intended.source === 'bot' || intended.source === 'fallback';
    if (controlled.intent.kind !== 'heuristic' && resolvedToBot) {
      console.log(`[ActiveGameManager] Intent fallback for ${gameId}:${controlled.id}: intent=${controlled.intent.kind} could not be honoured this turn → committing ${intended.source} move ${intended.direction}`);
    }
    if (previous?.source === 'manual' && (intended.source !== 'manual' || intended.direction !== previous.move)) {
      console.log(`[ActiveGameManager] Staged move changed for ${gameId}:${controlled.id} within turn ${previous.turn}: was manual ${previous.move} → now ${intended.source} ${intended.direction}`);
    }
  }

  // The one validated read of a staged move: returns its Direction only when the
  // record is bound to this exact snake and turn, else null. This is the
  // multi-snake desync guard — a staged record left over from a different turn
  // (because another snake's /move advanced the shared board) is rejected rather
  // than committed as the wrong turn's move (e.g. a 180° reversal into our neck).
  private stagedMoveForTurn(controlled: ControlledSnake, snakeId: string, turn: number): Direction | null {
    const staged = controlled.staged;
    return staged && staged.snakeId === snakeId && staged.turn === turn ? staged.move : null;
  }

  // Resolves the move to commit for `committedTurn`: the staged move when it is
  // aligned, otherwise the turn's bot recommendation (which lives on the pending
  // move, immune to cross-snake staged pollution), then the hard 'up' floor.
  private commitStagedMove(gameId: string, snakeId: string, committedTurn: number, context: string): Direction {
    const controlled = this.games.get(gameId)?.controlledSnakes.get(snakeId);
    if (!controlled) return 'up';
    const aligned = this.stagedMoveForTurn(controlled, snakeId, committedTurn);
    if (aligned) return aligned;
    const fallback = controlled.pendingMove?.botMove || 'up';
    const staged = controlled.staged;
    console.warn(`[ActiveGameManager] Staged-move turn mismatch (${context}) for ${gameId}:${snakeId}: committing turn ${committedTurn}, staged ${staged ? `turn ${staged.turn} (${staged.source})` : 'none'}; falling back to bot move ${fallback}`);
    return fallback;
  }

  getActiveIntentModesForGame(gameId: string): { [snakeId: string]: IntentMode } {
    const game = this.games.get(gameId);
    if (!game) return {};
    const result: { [snakeId: string]: IntentMode } = {};
    for (const [snakeId, cs] of game.controlledSnakes) {
      result[snakeId] = cs.intent.kind;
    }
    return result;
  }

  getRoutesForGame(gameId: string): { [snakeId: string]: Coord[] } {
    const game = this.games.get(gameId);
    if (!game) return {};
    const result: { [snakeId: string]: Coord[] } = {};
    for (const [snakeId, cs] of game.controlledSnakes) {
      if (cs.intent.kind === 'waypoint' && cs.intent.route.length > 0) {
        result[snakeId] = cs.intent.route;
      }
    }
    return result;
  }

  private static directionFromTo(from: Coord, to: Coord): Direction | null {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if (dx === 1 && dy === 0) return 'right';
    if (dx === -1 && dy === 0) return 'left';
    if (dx === 0 && dy === 1) return 'up';
    if (dx === 0 && dy === -1) return 'down';
    return null;
  }

  // Returns the move direction the snake should take next according to its
  // premove queue, or null if the queue is empty / disconnected from the
  // anchor. Only the immediate next cell is consulted; subsequent cells
  // are advanced one per turn by `advancePremoveQueueAfterMove`.
  //
  // The queue is anchored at the PROJECTED head — the cell the snake will
  // occupy after any move already committed this turn — matching where the
  // path is rendered (drawPremoveOverlay) and where the client authors the
  // queue (addPremoveCellAt). Pre-commit the projected head equals the live
  // head, so this is identical to measuring from the live head in the common
  // case; it only differs when a move is already committed this turn.
  private getPremoveDirection(gameId: string, snakeId: string): Direction | null {
    const game = this.games.get(gameId);
    if (!game?.boardState) return null;
    const controlled = game.controlledSnakes.get(snakeId);
    if (!controlled || controlled.intent.kind !== 'queue' || controlled.intent.cells.length === 0) return null;
    const anchor = this.getProjectedHead(gameId, snakeId);
    if (!anchor) return null;
    const target = controlled.intent.cells[0];
    // Adjacency alone is not validity: a retained queue cell can be the cell
    // the snake just vacated (its neck), and deriving a direction onto it is a
    // guaranteed 180° self-collision. Refuse it; the caller falls back to bot.
    if (this.isStepBehindAnchor(gameId, snakeId, target)) {
      console.warn(`[ActiveGameManager] Stale premove queue for ${gameId}:${snakeId}: first cell (${target.x},${target.y}) is the just-vacated neck — refusing 180° reversal, falling back to bot`);
      return null;
    }
    return ActiveGameManager.directionFromTo(anchor, target);
  }

  // Called after every resolved move to keep the queue in lock-step with the
  // actual snake position. If the move matches the planned next cell, pop it.
  // If it diverged (manual override, fallback move, etc.), abandon the plan —
  // the snake is now somewhere the queue can't reach, so the rest is stale.
  //
  // Anchoring + tolerance contract (matches the renderer and the client):
  // this runs AFTER resolvePendingMove set moveCommittedThisTurn/committedMove,
  // so getProjectedHead() returns the cell the snake will occupy this turn —
  // its real resulting position. Three outcomes, measured against that cell:
  //   1. DRAIN   — projected head == queue[0]: we stepped onto the planned
  //                cell, so pop it. If the queue is now empty, fall back to
  //                the heuristic (the plan is genuinely exhausted).
  //   2. HOLD    — projected head != queue[0] but is still adjacent to it
  //                (the bot/safety-timer covered a turn the queue couldn't
  //                resolve — a transient race or momentary non-adjacency).
  //                Keep the queue and the 'queue' mode untouched; next turn the
  //                live head equals this projected head, so the queue resolves
  //                again. This is the single-ambiguous-turn tolerance.
  //   3. CLEAR   — projected head is neither queue[0] nor adjacent to it: the
  //                snake's real position is provably off the planned path (true
  //                divergence). Abandon the plan and revert to the heuristic.
  private advancePremoveQueueAfterMove(gameId: string, snakeId: string, move: Direction): void {
    const game = this.games.get(gameId);
    if (!game?.boardState) return;
    const controlled = game.controlledSnakes.get(snakeId);
    if (!controlled || controlled.intent.kind !== 'queue' || controlled.intent.cells.length === 0) return;
    const cells = controlled.intent.cells;
    const snake = game.boardState.board.snakes.find(s => s.id === snakeId);
    const liveHead = snake?.head || snake?.body?.[0];
    const projected = this.getProjectedHead(gameId, snakeId);
    if (!projected) return;
    const next = cells[0];
    const headInfo = `liveHead=(${liveHead?.x},${liveHead?.y}) projectedHead=(${projected.x},${projected.y}) queueHead=(${next.x},${next.y}) move=${move}`;

    if (projected.x === next.x && projected.y === next.y) {
      cells.shift();
      // Queue drained → no source left, fall back to the heuristic.
      if (cells.length === 0) {
        console.log(`[ActiveGameManager] Premove queue drained for ${gameId}:${snakeId}: ${headInfo}`);
        this.setIntent(gameId, snakeId, { kind: 'heuristic' });
      } else {
        console.log(`[ActiveGameManager] Premove queue advanced for ${gameId}:${snakeId}: ${headInfo}, ${cells.length} remaining`);
        this.stageMove(gameId, snakeId);
      }
    } else if (liveHead && next.x === liveHead.x && next.y === liveHead.y) {
      // The queue's next cell is the cell we are LEAVING this turn. Holding it
      // would make next turn's derived direction a 180° reversal into our own
      // just-vacated neck (this was the root cause of real reversal deaths).
      // The plan points backwards → it is stale, not "one ambiguous turn".
      console.log(`[ActiveGameManager] Premove queue points backwards for ${gameId}:${snakeId}: ${headInfo}, clearing`);
      this.setIntent(gameId, snakeId, { kind: 'heuristic' });
    } else if (ActiveGameManager.directionFromTo(projected, next) !== null) {
      // Still adjacent to the plan head — a single ambiguous turn the bot
      // covered. Hold the queue; it resumes next turn from the projected head.
      console.log(`[ActiveGameManager] Premove queue held (bot covered one turn) for ${gameId}:${snakeId}: ${headInfo}, ${cells.length} retained`);
    } else {
      console.log(`[ActiveGameManager] Premove queue diverged for ${gameId}:${snakeId}: ${headInfo}, clearing`);
      this.setIntent(gameId, snakeId, { kind: 'heuristic' });
    }
  }

  setPremoveQueue(gameId: string, snakeId: string, queue: unknown, userId: string): boolean {
    const game = this.games.get(gameId);
    if (!game) return false;
    const controlled = game.controlledSnakes.get(snakeId);
    if (!controlled) return false;
    if (controlled.selectedBy !== userId) return false;

    const sanitized: Coord[] = [];
    if (Array.isArray(queue)) {
      const board = game.boardState?.board;
      const w = board?.width ?? 0;
      const h = board?.height ?? 0;
      for (let i = 0; i < Math.min(queue.length, 200); i++) {
        const c = queue[i] as { x?: unknown; y?: unknown } | null;
        if (!c) continue;
        const x = Number(c.x);
        const y = Number(c.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const ix = Math.floor(x);
        const iy = Math.floor(y);
        if (w > 0 && (ix < 0 || ix >= w)) continue;
        if (h > 0 && (iy < 0 || iy >= h)) continue;
        sanitized.push({ x: ix, y: iy });
      }
    }
    // Starting/replacing a queue activates Queue mode (replacing waypoint and
    // any manual selection). Emptying it falls back to the heuristic.
    if (sanitized.length > 0) {
      this.setIntent(gameId, snakeId, { kind: 'queue', cells: sanitized });
    } else if (controlled.intent.kind === 'queue') {
      this.setIntent(gameId, snakeId, { kind: 'heuristic' });
    } else {
      this.stageMove(gameId, snakeId);
    }
    return true;
  }

  setPendingMove(gameId: string, snakeId: string, res: Response, gameTimeout: number, serverExpiryTime: number | null = null, turn: number = 0): PendingMove {
    const game = this.games.get(gameId);
    if (!game) throw new Error(`Game ${gameId} not registered`);

    const controlled = game.controlledSnakes.get(snakeId);
    if (!controlled) throw new Error(`Snake ${snakeId} not controlled in game ${gameId}`);

    if (controlled.pendingMove && !controlled.pendingMove.resolved) {
      // The prior turn's staged move is still in place (this turn's board hasn't
      // been processed yet); commit it for the PRIOR pending's turn so an absent
      // or wrong-turn record falls back instead of submitting a wrong-turn move.
      const move = this.commitStagedMove(gameId, snakeId, controlled.pendingMove.turn, 'previous-turn-cleanup');
      console.log(`[ActiveGameManager] Previous-turn-cleanup for ${gameId}:${snakeId} turn ${controlled.pendingMove.turn}: using ${move}`);
      this.resolvePendingMove(gameId, snakeId, move, 'previous-turn-cleanup');
    }

    // The committed move still has to travel back to the game server before its
    // deadline (serverExpiryTime). The buffer is user-configurable per game
    // (adjustable live from the play page, shared by all viewers) so the
    // player can trade decision time against network safety margin explicitly.
    // The measured ping remains a displayed diagnostic only. Turn 0 keeps the
    // large first-move warm-up buffer.
    const bufferMs = turn === 0 ? Math.max(5000, game.commitBufferMs) : game.commitBufferMs;
    game.effectiveCommitBufferMs = bufferMs;
    let timeoutMs: number;
    if (serverExpiryTime) {
      const now = Date.now();
      timeoutMs = Math.max(serverExpiryTime - now - bufferMs, 50);
    } else {
      timeoutMs = Math.max(gameTimeout - bufferMs, 50);
    }
    console.log(`[ActiveGameManager] Safety timer set for ${gameId}:${snakeId} turn ${game.currentTurn}: serverExpiryTime=${serverExpiryTime}, gameTimeout=${gameTimeout}ms, firing in ${timeoutMs}ms`);

    const pending: PendingMove = {
      res,
      timer: setTimeout(() => {
        if (!pending.resolved) {
          // The deadline is the sole commit path for every snake. It reads the
          // staged move (kept current by stageMove through every input change
          // this turn) validated against this pending's turn.
          const move = this.commitStagedMove(gameId, snakeId, pending.turn, 'safety-timer');
          const heldNote = controlled.holdTurnsRemaining > 0 ? ` [held ${controlled.holdTurnsRemaining}]` : '';
          console.log(`[ActiveGameManager] Safety timer fired for ${gameId}:${snakeId}${heldNote} turn ${pending.turn}: using ${move} (intent: ${controlled.intent.kind}, selectedBy=${controlled.selectedBy})`);
          this.resolvePendingMove(gameId, snakeId, move, 'safety-timer');
        } else {
          console.log(`[ActiveGameManager] Safety timer fired for ${gameId}:${snakeId} but already resolved`);
        }
      }, timeoutMs),
      turnData: null,
      botMove: null,
      resolved: false,
      turn
    };

    controlled.pendingMove = pending;
    controlled.moveCommittedThisTurn = false;
    controlled.committedMove = null;
    return pending;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Move-source priority for a controlled snake. The intent union holds exactly
  // one source at a time; computeIntendedMove resolves it to a single direction
  // and stageMove binds that into `staged`:
  //   1. Manual user selection         — setUserSelection (sets a single-turn
  //                                      {kind:'manual'} intent, structurally
  //                                      superseding any queue/waypoint; this is
  //                                      the "manual override drops the plan"
  //                                      contract)
  //   2. Queued premove (queue head)   — getPremoveDirection, applied
  //                                      identically to selected AND
  //                                      unselected snakes.
  //   3. Goto route head (waypoint)    — first step of the rendered green path
  //   4. Bot recommendation            — the heuristic default
  //   5. Hard fallback                 — literal 'up' if nothing else available
  //
  // Every controlled snake (selected or not) stays staged until its per-snake
  // safety timer fires at the turn deadline — the sole commit path. The only
  // exception is the armed-suicide explicit kill.
  //
  // Ownership of the premove queue: server-only mutations are done in
  // `setPremoveQueue` (in response to client `set-premove`), `setUserSelection`
  // (clear on 'manual' override), and `advancePremoveQueueAfterMove` (pop /
  // clear on divergence). Clients never advance the queue themselves; they
  // render the broadcast snapshot.
  // ────────────────────────────────────────────────────────────────────────
  setBotRecommendation(gameId: string, snakeId: string, move: Direction, turnData: TurnData): void {
    const game = this.games.get(gameId);
    if (!game) return;

    const controlled = game.controlledSnakes.get(snakeId);
    if (!controlled) return;

    const incomingTurn = turnData.gameState.turn;
    game.lastActivityAt = Date.now();
    game.gameTimeout = turnData.gameState.game.timeout || game.gameTimeout;
    game.currentTurn = Math.max(game.currentTurn, incomingTurn);

    let boardUpdated = false;
    if (incomingTurn > game.boardStateTurn) {
      game.boardState = turnData.gameState;
      game.boardStateTurn = incomingTurn;

      for (const snake of turnData.gameState.board.snakes) {
        if (!game.snakes.has(snake.id)) {
          game.snakes.set(snake.id, {
            id: snake.id,
            name: snake.name,
            emoji: snake.emoji || '',
          });
        }
      }

      // Per-turn flag reset only. This loop runs on the board-advancing snake's
      // /move, so it must NOT mutate any other snake's staged move or intent
      // mode (no stageMove side-effects). Resetting commit flags and
      // decrementing the queue-hold counter is safe shared per-turn bookkeeping;
      // stale-manual revert and staged-move re-derivation are handled per-snake
      // (for THIS snake only) further below, after previous-turn cleanup.
      for (const [, cs] of game.controlledSnakes) {
        cs.moveCommittedThisTurn = false;
        cs.committedMove = null;
        if (cs.holdTurnsRemaining > 0) {
          cs.holdTurnsRemaining = Math.max(0, cs.holdTurnsRemaining - 1);
        }
      }

      boardUpdated = true;
    } else if (incomingTurn === game.boardStateTurn) {
      const existingSnakeCount = game.boardState?.board.snakes.length || 0;
      const incomingSnakeCount = turnData.gameState.board.snakes.length;
      if (existingSnakeCount !== incomingSnakeCount) {
        console.log(`[ActiveGameManager] Consistency check: board snake count mismatch on turn ${incomingTurn}: existing=${existingSnakeCount} incoming=${incomingSnakeCount} (snake=${snakeId})`);
      }
    }

    controlled.latestTurnData = turnData;
    controlled.botRecommendation = move;
    // Re-anchor the green goto route at the PROJECTED head from the freshly
    // stored board state — do NOT adopt the strategy's route, which is anchored
    // at the LIVE head. Everywhere else on the server (getGotoRouteDirection,
    // recomputeGotoRoute, the rendered path) anchors at the projected head; if
    // we stored a live-head route here, after a move is committed this turn its
    // first cell is no longer adjacent to the projected head, getGotoRouteDirection
    // returns null, and the snake silently reverts to the bot's straight move
    // while still displaying the green path (Bug B). recomputeGotoRoute uses the
    // same BFS, so it self-clears the route to [] when the target is gone/
    // unreachable, and is a no-op when not in waypoint mode.
    this.recomputeGotoRoute(gameId, snakeId);

    if (controlled.pendingMove && !controlled.pendingMove.resolved) {
      controlled.pendingMove.botMove = move;
      controlled.pendingMove.turnData = turnData;
    }

    // Re-stage ONLY this snake on its OWN /move, never the others when the board
    // advances: a cross-snake refresh would rebind another snake's still-pending
    // prior-turn move to the new turn, and previous-turn-cleanup would then submit
    // the wrong turn's move (a 180° reversal into its own neck). The prior record
    // was already committed by previous-turn-cleanup, so we drop it as a whole and
    // re-stage for the new turn. computeIntendedMove keeps manual > queue >
    // waypoint > bot precedence, so a same-turn manual selection stays
    // authoritative.
    //
    // Manual is single-turn: the staged record carries the turn the manual
    // selection was made for. If that turn is behind the current board turn the
    // selection is stale (it was for a prior turn) and reverts to the heuristic;
    // a manual selection made for THIS turn (staged turn == board turn, e.g. the
    // bot-compute-window race) stays authoritative and is re-derived below.
    const prevStagedTurn = controlled.staged?.turn ?? null;
    controlled.staged = null;
    if (controlled.intent.kind === 'manual' && prevStagedTurn !== game.boardStateTurn) {
      this.setIntent(gameId, snakeId, { kind: 'heuristic' });
    } else {
      this.stageMove(gameId, snakeId);
    }

    // The armed-suicide path is a deliberate explicit-kill exception to the
    // deadline-only commit model: it resolves the move immediately. Every
    // other snake (selected or not) now stays staged until its safety timer.
    if (controlled.suicideArmed && controlled.pendingMove && !controlled.pendingMove.resolved) {
      const suicideMove = computeSuicideMove(turnData.gameState);
      console.log(`[ActiveGameManager] SUICIDE: submitting ${suicideMove} for ${gameId}:${snakeId} (turn ${incomingTurn})`);
      controlled.suicideArmed = false;
      // Second fatal-consent mint point (kill-all): stage with consent so the
      // deliberate death passes the staged-move writer's gate, then commit.
      this.setIntent(gameId, snakeId, { kind: 'manual', move: suicideMove, fatalConsent: mintFatalMoveConsent() });
      // setIntent re-staged synchronously; the cast defeats TS's stale
      // narrowing from the `controlled.staged = null` above.
      this.resolvePendingMove(gameId, snakeId, (controlled.staged as StagedMove | null)?.move ?? suicideMove, 'suicide');
    }

    if (boardUpdated) {
      this.notifyBoardUpdate(gameId, turnData.gameState);
    }
    this.notifyTurnUpdate(gameId, snakeId, turnData);
  }

  // Stage a user's manual selection as the snake's next move. This is the
  // "manual override drops the plan" contract: it replaces the intent with a
  // single-turn manual intent (structurally superseding any queue/waypoint) and
  // re-stages the move via setIntent. Staging never commits — the move is
  // finalized only when the per-snake safety timer fires at the turn deadline.
  setUserSelection(gameId: string, snakeId: string, move: Direction): void {
    const game = this.games.get(gameId);
    if (!game) return;
    const controlled = game.controlledSnakes.get(snakeId);
    if (!controlled?.pendingMove || controlled.pendingMove.resolved) return;

    this.setIntent(gameId, snakeId, { kind: 'manual', move });
    console.log(`[ActiveGameManager] User staged move for ${gameId}:${snakeId}: ${move} (intent: ${controlled.intent.kind}, turn ${game.currentTurn}, not yet committed)`);
  }

  // The dialog-accept entry point — the FIRST fatal-consent mint point. Called
  // by the WS layer when the controlling user confirmed the fatal-move dialog.
  // The client message carries only the claim; fatality is RE-validated here,
  // server-side, before consent is minted, and the consented manual intent is
  // set through the normal single-writer path (setIntent → stageMove). If the
  // turn already ended (pending resolved/gone), the confirmation is too late
  // and is dropped — the bot fallback already committed. Returns whether the
  // move was staged.
  confirmFatalMove(gameId: string, snakeId: string, move: Direction, userId: string): boolean {
    const game = this.games.get(gameId);
    if (!game) return false;
    const controlled = game.controlledSnakes.get(snakeId);
    if (!controlled) return false;
    if (controlled.selectedBy !== userId) return false;
    if (!controlled.pendingMove || controlled.pendingMove.resolved) {
      console.log(`[ActiveGameManager] Fatal-move confirmation for ${gameId}:${snakeId} (${move}) arrived after the turn ended — ignored (bot fallback already committed)`);
      return false;
    }
    const stillFatal = this.isMoveFatal(gameId, snakeId, move);
    const consent = stillFatal ? mintFatalMoveConsent() : undefined;
    console.log(`[ActiveGameManager] User CONFIRMED ${stillFatal ? 'fatal' : 'no-longer-fatal'} move ${move} for ${gameId}:${snakeId} — staging with${consent ? '' : 'out'} consent`);
    this.setIntent(gameId, snakeId, { kind: 'manual', move, fatalConsent: consent });
    return true;
  }

  updateGameState(gameId: string, snakeId: string, gameState: GameState): void {
    const game = this.games.get(gameId);
    if (!game) return;

    game.gameTimeout = gameState.game.timeout || game.gameTimeout;
    game.lastActivityAt = Date.now();

    const controlled = game.controlledSnakes.get(snakeId);
    if (controlled) {
      controlled.name = gameState.you.name || controlled.name;
      controlled.emoji = gameState.you.emoji || controlled.emoji;
    }

    const boardSnakeIds = new Set(gameState.board.snakes.map(s => s.id));
    const youId = gameState.you.id;
    if (!boardSnakeIds.has(youId)) {
      console.log(`[ActiveGameManager] Consistency check: our snake ${youId} not found in board snakes array`);
    }

    // Auto-clear green ("goto") waypoint when the snake's head has been
    // at the target cell at any point — check both the current head and
    // the most recent body segments so a snake that already advanced past
    // the target by the time /move fires still clears the waypoint.
    if (controlled?.intent.kind === 'waypoint' && controlled.intent.style === 'green') {
      const wp = controlled.intent.target;
      const you = gameState.you;
      const head = you?.head;
      const body = you?.body || [];
      const headHit = !!head && head.x === wp.x && head.y === wp.y;
      // body[0] === head; body[1] is where the head was last turn. If the
      // snake stepped onto the target last turn and is now stepping off,
      // body[1] catches that case.
      const justSteppedThrough = body.length > 1 && body[1].x === wp.x && body[1].y === wp.y;
      if (headHit || justSteppedThrough) {
        console.log(`[ActiveGameManager] Auto-clearing green waypoint for ${gameId}:${snakeId} (head=${head?.x},${head?.y} wp=${wp.x},${wp.y} reason=${headHit ? 'head' : 'body[1]'})`);
        this.setIntent(gameId, snakeId, { kind: 'heuristic' });
      }
    }
  }

  private resolvePendingMove(gameId: string, snakeId: string, move: Direction, source: string = 'unknown'): void {
    const game = this.games.get(gameId);
    if (!game) return;

    const controlled = game.controlledSnakes.get(snakeId);
    if (!controlled?.pendingMove || controlled.pendingMove.resolved) return;

    const pending = controlled.pendingMove;
    pending.resolved = true;
    clearTimeout(pending.timer);

    // Commit is a PURE PASSTHROUGH: the staged move is sacrosanct and is sent
    // to the game server verbatim — there is deliberately no intelligence here.
    // All safety reasoning happens upstream at staging time (computeIntendedMove
    // and the bot's own safe-move selection), and a staged move that is certain
    // death is surfaced to the human via the red fatal-move marker
    // (isStagedMoveFatal), never silently rewritten at the last instant. The
    // previous commit-time guard could flip a deliberate (e.g. invulnerable
    // attack) move to 'up'; that is exactly the behaviour we forbid here.
    // (Suicide already deliberately steers into death and needs no guard.)

    controlled.moveCommittedThisTurn = true;
    controlled.committedMove = move;

    // Persist the move we actually submitted onto this turn's decision row. The
    // move was committed for board turn `pending.turn`, whose decision was logged
    // with decision_logs.turn = pending.turn + 1 (the logger records the turn the
    // move executes INTO), so that +1 is the update key.
    // The consent flag counts only when the staged record is bound to this exact
    // turn and the committed move matches it (otherwise it's a bot/fallback move).
    const staged = controlled.staged;
    const fatalConsented = !!staged && staged.snakeId === snakeId &&
      staged.turn === pending.turn && staged.move === move && staged.fatalConsented;
    DecisionLogger.getInstance().recordSubmittedMove(gameId, snakeId, pending.turn + 1, move, fatalConsented);

    // Re-anchor the green goto route at the cell we'll occupy after this
    // committed move, so the rendered path — and next turn's first step —
    // start from there instead of the now-stale head.
    this.recomputeGotoRoute(gameId, snakeId);

    // Keep the server-side premove queue in lock-step with the actual move.
    // This works for both selected (client submitted) and unselected
    // (auto-pilot) snakes — whoever drove the move, the queue advances or
    // clears based on what actually happened.
    this.advancePremoveQueueAfterMove(gameId, snakeId, move);

    try {
      const headersSent = pending.res.headersSent;
      const finished = pending.res.writableFinished;
      const destroyed = pending.res.destroyed;
      if (headersSent || finished || destroyed) {
        console.error(`[ActiveGameManager] Response already consumed for ${gameId}:${snakeId}: headersSent=${headersSent}, finished=${finished}, destroyed=${destroyed}`);
      }
      pending.res.json({
        move: move,
        shout: `Centaur mode! Turn ${game.currentTurn}`
      });
      console.log(`[ActiveGameManager] Move response sent for ${gameId}:${snakeId}: ${move} (source: ${source}, headersSent=${pending.res.headersSent})`);
    } catch (e) {
      console.error(`[ActiveGameManager] Error sending move response for ${gameId}:${snakeId}:`, e);
    }

    controlled.pendingMove = null;

    this.notifyMoveCommitted(gameId, snakeId, move, source);
  }

  // Emit a single, greppable "fully idle" line once the manager holds zero
  // active games and zero connected users. This is the signal the operator
  // watches for in deployment logs before expecting the instance to scale to
  // zero (the unref'd timers no longer keep the event loop alive at that point).
  private logIfFullyIdle(): void {
    if (this.games.size > 0) return;
    let totalUsers = 0;
    for (const game of this.games.values()) {
      totalUsers += game.connectedUsers.size;
    }
    if (totalUsers > 0) return;
    console.log('[ActiveGameManager] Manager is now fully idle (no active games, no connected users) — instance can scale to zero');
  }

  shutdown(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval as any);
      this.pingInterval = null;
    }
    if (this.staleGameCleanupInterval) {
      clearInterval(this.staleGameCleanupInterval as any);
      this.staleGameCleanupInterval = null;
    }
  }

  startStaleGameCleanup(intervalMs: number = 300000, maxIdleMs: number = 600000): void {
    if (this.staleGameCleanupInterval) return;
    this.staleGameCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [gameId, game] of this.games) {
        const idleTime = now - game.lastActivityAt;
        if (idleTime > maxIdleMs) {
          console.log(`[ActiveGameManager] Cleaning up stale game: ${gameId} (idle: ${Math.round(idleTime / 1000)}s)`);
          for (const [snakeId, controlled] of game.controlledSnakes) {
            if (controlled.pendingMove && !controlled.pendingMove.resolved) {
              this.resolvePendingMove(gameId, snakeId, controlled.pendingMove.botMove || 'up', 'stale-cleanup');
            }
            this.notifyGameListChange('removed', gameId, snakeId);
          }
          this.clearColorReleaseTimers(game);
          this.games.delete(gameId);
          this.logIfFullyIdle();
        }
      }
    }, intervalMs);
    // Unref so this long-cycle timer doesn't keep the event loop alive on its
    // own, allowing the autoscale instance to drain to zero when idle.
    if (typeof (this.staleGameCleanupInterval as any).unref === 'function') {
      (this.staleGameCleanupInterval as any).unref();
    }
    console.log(`[ActiveGameManager] Stale-game cleanup interval started (every ${Math.round(intervalMs / 1000)}s, maxIdle ${Math.round(maxIdleMs / 1000)}s, unref'd)`);
  }
}

function computeSuicideMove(gameState: GameState): Direction {
  const you = gameState.you;
  const head = you.body[0];
  const neck = you.body[1];
  if (neck && (neck.x !== head.x || neck.y !== head.y)) {
    if (neck.x < head.x) return "left";
    if (neck.x > head.x) return "right";
    if (neck.y < head.y) return "down";
    return "up";
  }
  const w = gameState.board.width;
  const h = gameState.board.height;
  const distLeft = head.x;
  const distRight = w - 1 - head.x;
  const distDown = head.y;
  const distUp = h - 1 - head.y;
  const min = Math.min(distLeft, distRight, distDown, distUp);
  if (min === distLeft) return "left";
  if (min === distRight) return "right";
  if (min === distDown) return "down";
  return "up";
}
