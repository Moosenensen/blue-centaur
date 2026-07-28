import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { db, pool } from '../database/db';
import { decisionLogs } from '../database/schema';
import { Direction } from '../types/battlesnake';
import { TeamDetector } from './team-detector';

export interface DecisionLogEntry {
  gameId: string;
  snakeId: string;
  snakeName: string;
  turn: number;
  position: { x: number; y: number };
  health: number;
  safeMoves: Direction[];
  botRecommendation: Direction;
  moveEvaluations: {
    move: Direction;
    score: number;
    numStates: number;
    projectedTerritoryCells?: { [snakeId: string]: { x: number; y: number }[] };
    breakdown?: {
      myLength: number;
      myTerritory: number;
      myControlledFood: number;
      myControlledFertile: number;

      teamLength: number;
      teamTerritory: number;
      teamControlledFood: number;

      foodDistance: number;
      foodProximity: number;
      foodEaten: number;

      enemyTerritory?: number;
      enemyLength?: number;

      kills?: number;
      deaths?: number;

      waypointGoto?: number;
      waypointNear?: number;

      enemyH2HRisk?: number;
      allyH2HRisk?: number;

      selfSpace?: number;

      aggression?: number;
      trapped?: number;

      fertileTerritory?: number;
      foodDistanceInverse?: number;
      myFoodCount?: number;
      teamFoodCount?: number;
      teamFertileScore?: number;

      weights: any;
      weighted: any;
    };
  }[];
  gameState: any;
  territoryCells?: { [snakeId: string]: { x: number; y: number }[] };
}

// Compact pre-serialized row. Holds only primitives + already-stringified
// JSON blobs so the original gameState / territoryCells object graphs can be
// GC'd immediately after logDecision() returns. This is the key memory win:
// even a backed-up queue only holds compact strings, not live nested objects.
interface SerializedRow {
  gameId: string;
  snakeId: string;
  snakeName: string;
  turn: number;
  positionX: number;
  positionY: number;
  health: number;
  safeMoves: Direction[];
  botRecommendation: Direction;
  moveEvaluationsJson: string;
  gameStateJson: string;
  retries: number;
}

// A single controlled snake within a (game, team) group, as surfaced to the
// history viewer's left panel.
export interface GameTeamMember {
  snake_id: string;
  snake_name: string;
  color: string | null;
  length: number | null;
  turns: number;
}

// One left-panel entry: a single team within a single game, framed from our
// team's perspective. `default_snake_id` is the member the viewer should load
// first (the longest/primary member).
export interface GameTeamGroup {
  game_id: string;
  team_key: string;
  team_label: string;
  team_color: string | null;
  timestamp: string;
  turns: number;
  default_snake_id: string;
  snakes: GameTeamMember[];
}

// Turns a raw game-server team id like "team_red" into a friendly label
// ("Team Red"). Returns null when there's nothing usable so callers can fall
// back to squad/color.
function prettifyTeamName(teamId: string | null | undefined): string | null {
  if (!teamId) return null;
  const trimmed = teamId.trim();
  if (!trimmed) return null;
  return trimmed
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// A back-fill onto an already-inserted decision row: the final move we actually
// submitted to the server (submitted_move) or the move the server reported it
// made (server_move, read from the next turn's lastMoves map). Both target a
// specific (game, snake, turn) row and always land on decision_logs.turn = the
// board turn's decision row (see recordSubmittedMove / recordServerMoves for the
// turn-offset math).
interface MoveUpdate {
  gameId: string;
  snakeId: string;
  turn: number;
  column: 'submitted_move' | 'server_move';
  move: Direction;
  // Only for submitted_move: whether the move carried fatal-move consent.
  fatalConsent?: boolean;
  retries: number;
}

// The async worker queue holds either per-move inserts or move-column back-fills.
// A back-fill always targets a row inserted at least a full turn earlier, and the
// worker processes all inserts in a batch before any move-updates in the same
// batch, so the row a back-fill targets exists by the time we UPDATE it.
type QueueItem =
  | { kind: 'insert'; row: SerializedRow }
  | { kind: 'moveUpdate'; update: MoveUpdate };

const BATCH_SIZE = 100;

export class DecisionLogger {
  private static instance: DecisionLogger;

  private readonly MAX_QUEUE_SIZE = 50000;
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY_MS = 100;
  private queue: QueueItem[] = [];
  private droppedCount = 0;

  // Worker loop coordination
  private workerRunning = true;
  private workerPromise: Promise<void>;
  private wakeup: (() => void) | null = null;

  private constructor() {
    // Schema is owned by Drizzle (db:push in dev, Publish diff in prod); this
    // class assumes the tables already exist and does no startup-time DDL.
    this.workerPromise = this.runWorkerLoop();
  }

  public static getInstance(): DecisionLogger {
    if (!DecisionLogger.instance) {
      DecisionLogger.instance = new DecisionLogger();
    }
    return DecisionLogger.instance;
  }

  // Synchronous, non-blocking enqueue. Pre-serializes everything so the live
  // gameState / territoryCells object graphs become GC-eligible immediately.
  public logDecision(entry: DecisionLogEntry): void {
    let moveEvaluationsJson: string;
    let gameStateJson: string;
    try {
      const moveEvalWithTerritory = {
        evaluations: entry.moveEvaluations,
        territoryCells: entry.territoryCells || {},
      };
      moveEvaluationsJson = JSON.stringify(moveEvalWithTerritory);
      gameStateJson = JSON.stringify(entry.gameState);
    } catch (e) {
      console.error('[DecisionLogger] Failed to serialize entry, dropping:', e);
      return;
    }

    const row: SerializedRow = {
      gameId: entry.gameId,
      snakeId: entry.snakeId,
      snakeName: entry.snakeName,
      turn: entry.turn,
      positionX: entry.position.x,
      positionY: entry.position.y,
      health: entry.health,
      safeMoves: entry.safeMoves,
      botRecommendation: entry.botRecommendation,
      moveEvaluationsJson,
      gameStateJson,
      retries: 0,
    };

    if (this.queue.length >= this.MAX_QUEUE_SIZE) {
      const dropped = this.queue.shift();
      this.droppedCount++;
      if (this.droppedCount % 100 === 0) {
        const d = dropped?.kind === 'insert' ? dropped.row : undefined;
        console.warn(`[DecisionLogger] Queue full! Dropped ${this.droppedCount} total entries. Last dropped: game=${d?.gameId}, turn=${d?.turn}`);
      }
    }

    this.queue.push({ kind: 'insert', row });
    this.signalWakeup();
  }

  // Record the final move we actually submitted to the game server for a snake's
  // turn. Called from the commit path (resolvePendingMove). `turn` must be the
  // decision_logs.turn of the target row: a move committed for board turn N was
  // logged with decision_logs.turn = N+1, so callers pass boardTurn + 1.
  public recordSubmittedMove(gameId: string, snakeId: string, turn: number, move: Direction, fatalConsent: boolean = false): void {
    this.queue.push({
      kind: 'moveUpdate',
      update: { gameId, snakeId, turn, column: 'submitted_move', move, fatalConsent, retries: 0 },
    });
    this.signalWakeup();
  }

  // Back-fill the server-decided move for every snake from a freshly-arrived
  // game state's `lastMoves` map. `lastMoves` on board turn T describes the moves
  // that transitioned turn T-1 → T; those are the server-decided moves for each
  // snake's decision at board turn T-1, whose rows were logged with
  // decision_logs.turn = (T-1)+1 = T. So the update key is exactly the arriving
  // turn T. Iterating ALL entries lets a still-alive peer's next move back-fill a
  // snake that has since died (it takes no further /move of its own). Updates for
  // snakes we never logged (enemies) simply match zero rows.
  public recordServerMoves(gameId: string, turn: number, lastMoves: Record<string, Direction> | null | undefined): void {
    if (!lastMoves) return;
    for (const [snakeId, move] of Object.entries(lastMoves)) {
      if (!move) continue;
      this.queue.push({
        kind: 'moveUpdate',
        update: { gameId, snakeId, turn, column: 'server_move', move, retries: 0 },
      });
    }
    this.signalWakeup();
  }

  private signalWakeup(): void {
    if (this.wakeup) {
      const w = this.wakeup;
      this.wakeup = null;
      w();
    }
  }

  private waitForWork(): Promise<void> {
    return new Promise<void>(resolve => {
      this.wakeup = resolve;
    });
  }

  private async runWorkerLoop(): Promise<void> {
    while (this.workerRunning || this.queue.length > 0) {
      if (this.queue.length === 0) {
        if (!this.workerRunning) break;
        await this.waitForWork();
        continue;
      }

      const batch = this.queue.splice(0, BATCH_SIZE);
      // Process all inserts in the batch first, then move-column back-fills, so a
      // back-fill enqueued in the same batch as its target's insert finds the row.
      const rows = batch
        .filter((item): item is { kind: 'insert'; row: SerializedRow } => item.kind === 'insert')
        .map(item => item.row);
      const moveUpdates = batch
        .filter((item): item is { kind: 'moveUpdate'; update: MoveUpdate } => item.kind === 'moveUpdate')
        .map(item => item.update);

      if (rows.length > 0) {
        try {
          await this.insertBatch(rows);
        } catch (error) {
          // Batched insert failed — fall back to per-row retry with backoff so
          // one poison row can't block the whole queue.
          console.warn(`[DecisionLogger] Batch insert failed (${rows.length} rows), falling back to per-row retry:`, (error as Error).message);
          for (const row of rows) {
            await this.insertSingleWithRetry(row);
          }
        }
      }

      for (const update of moveUpdates) {
        await this.applyMoveUpdateWithRetry(update);
      }
    }
  }

  private async applyMoveUpdate(update: MoveUpdate): Promise<void> {
    // Back-fill submitted_move / server_move onto the exact decision row for this
    // (game, snake, turn). No-op (zero rows) if the row doesn't exist — e.g. an
    // enemy snake we never logged, or turn 0 (which is answered without a strategy
    // decision, so it's never logged).
    if (update.column === 'submitted_move') {
      await db.execute(sql`
        UPDATE decision_logs
        SET submitted_move = ${update.move}, fatal_consent = ${update.fatalConsent ?? false}
        WHERE game_id = ${update.gameId}
          AND snake_id = ${update.snakeId}
          AND turn = ${update.turn}
      `);
      return;
    }
    await db.execute(sql`
      UPDATE decision_logs SET server_move = ${update.move}
      WHERE game_id = ${update.gameId}
        AND snake_id = ${update.snakeId}
        AND turn = ${update.turn}
    `);
  }

  private async applyMoveUpdateWithRetry(update: MoveUpdate): Promise<void> {
    while (true) {
      try {
        await this.applyMoveUpdate(update);
        return;
      } catch (error) {
        update.retries++;
        if (update.retries > this.MAX_RETRIES) {
          console.error(`[DecisionLogger] Failed to record ${update.column} after ${this.MAX_RETRIES} retries for game ${update.gameId}, snake ${update.snakeId}, turn ${update.turn}:`, error);
          return;
        }
        const delay = this.RETRY_DELAY_MS * Math.pow(2, update.retries - 1) * (0.5 + Math.random() * 0.5);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  private async insertBatch(rows: SerializedRow[]): Promise<void> {
    if (rows.length === 0) return;

    // The JSON blobs are kept as pre-serialized strings (memory win) and cast to
    // jsonb via sql`...` so Drizzle doesn't double-encode them. Omitted columns
    // (id/timestamp/created_at/submitted_move/server_move) use their defaults; the
    // two move columns are back-filled later via recordSubmittedMove/recordServerMoves.
    await db.insert(decisionLogs).values(
      rows.map(r => ({
        gameId: r.gameId,
        snakeId: r.snakeId,
        snakeName: r.snakeName,
        turn: r.turn,
        positionX: r.positionX,
        positionY: r.positionY,
        health: r.health,
        safeMoves: r.safeMoves,
        botRecommendation: r.botRecommendation,
        moveEvaluations: sql`${r.moveEvaluationsJson}::jsonb`,
        gameState: sql`${r.gameStateJson}::jsonb`,
      })),
    );
  }

  private async insertSingleWithRetry(row: SerializedRow): Promise<void> {
    while (true) {
      try {
        await this.insertBatch([row]);
        return;
      } catch (error) {
        row.retries++;
        if (row.retries > this.MAX_RETRIES) {
          console.error(`[DecisionLogger] Failed to log after ${this.MAX_RETRIES} retries. Dropping entry for game ${row.gameId}, turn ${row.turn}:`, error);
          this.droppedCount++;
          return;
        }
        const delay = this.RETRY_DELAY_MS * Math.pow(2, row.retries - 1) * (0.5 + Math.random() * 0.5);
        console.warn(`[DecisionLogger] Insert failed, retry ${row.retries}/${this.MAX_RETRIES} after ${Math.round(delay)}ms:`, (error as Error).message);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  public async queryLogs(filters: {
    gameId?: string;
    snakeId?: string;
    startTurn?: number;
    endTurn?: number;
    limit?: number;
    offset?: number;
  }): Promise<any[]> {
    try {
      const conditions = [];
      if (filters.gameId) conditions.push(eq(decisionLogs.gameId, filters.gameId));
      if (filters.snakeId) conditions.push(eq(decisionLogs.snakeId, filters.snakeId));
      if (filters.startTurn !== undefined) conditions.push(gte(decisionLogs.turn, filters.startTurn));
      if (filters.endTurn !== undefined) conditions.push(lte(decisionLogs.turn, filters.endTurn));

      // Alias to snake_case so the returned shape matches what the routes/UI
      // already read (position_x, safe_moves, bot_recommendation, etc.).
      let query = db
        .select({
          id: decisionLogs.id,
          timestamp: decisionLogs.timestamp,
          game_id: decisionLogs.gameId,
          snake_id: decisionLogs.snakeId,
          snake_name: decisionLogs.snakeName,
          turn: decisionLogs.turn,
          position_x: decisionLogs.positionX,
          position_y: decisionLogs.positionY,
          health: decisionLogs.health,
          safe_moves: decisionLogs.safeMoves,
          bot_recommendation: decisionLogs.botRecommendation,
          submitted_move: decisionLogs.submittedMove,
          fatal_consent: decisionLogs.fatalConsent,
          server_move: decisionLogs.serverMove,
          move_evaluations: decisionLogs.moveEvaluations,
          game_state: decisionLogs.gameState,
          created_at: decisionLogs.createdAt,
        })
        .from(decisionLogs)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(decisionLogs.gameId, decisionLogs.snakeId, decisionLogs.turn)
        .$dynamic();

      if (filters.limit) query = query.limit(filters.limit);
      if (filters.offset) query = query.offset(filters.offset);

      return await query;
    } catch (error) {
      console.error('[DecisionLogger] Failed to query logs:', error);
      return [];
    }
  }

  public async getGames(): Promise<GameTeamGroup[]> {
    try {
      // Per (game, snake) aggregate stats joined with a representative (latest)
      // logged game state so we can derive each snake's team identity. We only
      // pull the squad/color/length out of the JSONB blob rather than the whole
      // game_state to keep the listing payload small.
      const result = await db.execute(sql`
        WITH agg AS (
          SELECT
            game_id,
            snake_id,
            MAX(turn) - MIN(turn) + 1 AS turns,
            MAX(timestamp) AS timestamp
          FROM decision_logs
          GROUP BY game_id, snake_id
        ),
        latest AS (
          SELECT DISTINCT ON (game_id, snake_id)
            game_id,
            snake_id,
            snake_name,
            game_state->'you'->>'squad' AS squad,
            -- teamID is carried on the board snakes, not the 'you' object.
            (SELECT s->>'teamID'
               FROM jsonb_array_elements(game_state->'board'->'snakes') s
               WHERE s->>'id' = snake_id
               LIMIT 1) AS team_id,
            game_state->'you'->'customizations'->>'color' AS color,
            (game_state->'you'->>'length')::int AS length
          FROM decision_logs
          ORDER BY game_id, snake_id, turn DESC
        )
        SELECT
          a.game_id,
          a.snake_id,
          l.snake_name,
          a.turns,
          a.timestamp,
          l.squad,
          l.team_id,
          l.color,
          l.length
        FROM agg a
        JOIN latest l USING (game_id, snake_id)
        ORDER BY a.timestamp DESC
        LIMIT 500
      `);
      return this.groupGamesByTeam(result.rows as any);
    } catch (error) {
      console.error('[DecisionLogger] Failed to get games:', error);
      return [];
    }
  }

  // Collapses per-snake rows into one entry per (game, team) pair. Team identity
  // is derived with the same squad → color → id rule the live bot uses, so the
  // history grouping matches in-game team behavior. Rows are already ordered by
  // timestamp DESC, so the first time a group is seen sets its sort position.
  private groupGamesByTeam(
    rows: {
      game_id: string;
      snake_id: string;
      snake_name: string | null;
      turns: number | string;
      timestamp: string;
      squad: string | null;
      team_id: string | null;
      color: string | null;
      length: number | null;
    }[],
  ): GameTeamGroup[] {
    const groups = new Map<string, GameTeamGroup>();

    for (const row of rows) {
      const teamKey = TeamDetector.getTeamKey({
        id: row.snake_id,
        squad: row.squad ?? '',
        customizations: { color: row.color ?? '', head: '', tail: '' },
      });
      const groupKey = `${row.game_id}::${teamKey}`;
      const turns = typeof row.turns === 'string' ? parseInt(row.turns, 10) : row.turns;

      let group = groups.get(groupKey);
      if (!group) {
        group = {
          game_id: row.game_id,
          team_key: teamKey,
          // Prefer the game-server team name (teamID, e.g. "team_red"), then
          // squad, then color, then a generic label so we never surface a raw
          // hex code or uuid as the team name.
          team_label: prettifyTeamName(row.team_id) || row.squad || row.color || 'Team',
          team_color: row.color,
          timestamp: row.timestamp,
          turns,
          default_snake_id: row.snake_id,
          snakes: [],
        };
        groups.set(groupKey, group);
      }

      group.snakes.push({
        snake_id: row.snake_id,
        snake_name: row.snake_name || 'Unknown',
        color: row.color,
        length: row.length,
        turns,
      });

      // Keep the group timestamp/turn count as the max across its members.
      if (row.timestamp > group.timestamp) group.timestamp = row.timestamp;
      if (turns > group.turns) group.turns = turns;
      if (!group.team_color && row.color) group.team_color = row.color;
    }

    // Default perspective per group = the longest member (primary), a neutral
    // default for the viewer.
    for (const group of groups.values()) {
      let primary = group.snakes[0];
      for (const member of group.snakes) {
        if ((member.length ?? 0) > (primary.length ?? 0)) primary = member;
      }
      group.default_snake_id = primary.snake_id;
    }

    return Array.from(groups.values());
  }

  public async clearOldLogs(daysToKeep: number = 7): Promise<void> {
    try {
      await db.execute(sql`
        DELETE FROM decision_logs
        WHERE timestamp < NOW() - (${daysToKeep} * INTERVAL '1 day')
      `);
      console.log(`[DecisionLogger] Cleared logs older than ${daysToKeep} days`);
    } catch (error) {
      console.error('[DecisionLogger] Failed to clear old logs:', error);
    }
  }

  public async shutdown(): Promise<void> {
    console.log(`[DecisionLogger] Shutting down, flushing ${this.queue.length} queued entries...`);

    this.workerRunning = false;
    this.signalWakeup();

    await this.workerPromise;

    if (this.droppedCount > 0) {
      console.warn(`[DecisionLogger] Shutdown complete. Total dropped entries: ${this.droppedCount}`);
    } else {
      console.log('[DecisionLogger] Shutdown complete. All entries flushed.');
    }

    await pool.end();
  }

  public getQueueStats(): { queueSize: number; droppedCount: number; maxQueueSize: number } {
    return {
      queueSize: this.queue.length,
      droppedCount: this.droppedCount,
      maxQueueSize: this.MAX_QUEUE_SIZE,
    };
  }
}
