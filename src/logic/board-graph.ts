/**
 * Board graph representation for unified pathfinding.
 *
 * Two layers, deliberately separated:
 *  - PHYSICAL passability (`isPassable` / `isPassableAtTurn` / adjacency):
 *    walls, hazards and body segments with tail-vacate timing. This is
 *    subject-agnostic — it knows nothing about "us" — and is what the shared
 *    Voronoi territory BFS walks.
 *  - SUBJECTIVE passability (`passabilityFor` / `isPassableForSnake`): the
 *    single source of truth for "where can THIS snake walk", layering
 *    own-body/own-tail handling and invulnerability severability on top of the
 *    physical layer. Severability is inherently relative to who is moving, so it
 *    lives ONLY here and never in the shared physical graph.
 *
 * BoardGraph has no concept of `you`: every perspective-dependent query takes a
 * subject snake id.
 */

import { BoardSnapshot, Coord, Snake } from '../types/battlesnake';
import { TeamDetector } from './team-detector';

export type CellKey = string;

export interface BoardGraphConfig {
  // Tail growth variant:
  // 'grow-same-turn' - snake grows immediately when eating (tail doesn't move)
  // 'grow-next-turn' - snake grows on turn after eating (tail moves when eating)
  tailGrowthTiming: 'grow-same-turn' | 'grow-next-turn';

  // Maximum turns to look ahead for optimistic passability
  maxLookaheadTurns: number;
}

// Per-snake data needed for subjective passability, computed once at build time.
interface SnakeMeta {
  invuln: number;
  // Last absolute game turn on which `invuln` still applies. Read straight from
  // the server's invulnerabilityExpiryTurn; falls back to the current turn
  // (i.e. the state applies to this turn only) when the server omits it.
  expiryTurn: number;
  teamId: string;
  headKey: CellKey;
  tailKey: CellKey;
}

// One non-head body cell.
interface SegmentRecord {
  snakeId: string;
  isTail: boolean;
  // Turn this cell vacates if the owner never eats (pure geometry).
  optimisticDisappearTurn: number;
  // PHYSICAL vacate turn: geometry + food the owner could eat first, with NO
  // survival safety buffer. This is the true "cell is free" turn used by the
  // subject-agnostic Voronoi physical layer (isPassableAtTurn).
  physicalDisappearTurn: number;
  // SURVIVAL-conservative vacate turn: physical timing plus a one-turn safety
  // buffer. Used only by the pessimistic 'conservative' clearance mode.
  conservativeDisappearTurn: number;
  // Whether this cell blocks under static (non-turn-aware) rules. Interior
  // segments are always blocked; tails depend on growth timing / just-ate.
  staticBlocked: boolean;
}

// Subject-relative passability bundle returned by `passabilityFor`.
export interface SnakePassability {
  headKey: CellKey;
  tailKey: CellKey;
  // Can the subject occupy `coord` arriving `arrivalTurn` turns from now?
  passable: (coord: Coord, arrivalTurn: number) => boolean;
}

// How much body-segment clearance to assume when deciding passability:
//  - 'static':       no look-ahead. A body cell is passable only if it is an
//                    immediately-vacating tail (!staticBlocked); interior body
//                    is always a wall. Bodies treated as static walls.
//  - 'conservative': a cell is passable once its conservative disappear turn has
//                    passed. Conservative timing accounts for food the owner
//                    could eat (keeps growing) plus a one-turn safety buffer, so
//                    this is the timing used by survival reasoning.
//  - 'optimistic':   a cell is passable once its optimistic disappear turn has
//                    passed. Optimistic timing is pure tail geometry plus only
//                    the single eat we can confirm this turn.
export type ClearanceMode = 'static' | 'conservative' | 'optimistic';

export interface PassabilityOptions {
  // Body-segment clearance model. Defaults to 'static'.
  clearance?: ClearanceMode;
}

export class BoardGraph {
  private adjacencyList: Map<CellKey, Set<CellKey>>;
  private blockedCells: Set<CellKey>;
  private hazardCells: Set<CellKey>;
  private segmentAt: Map<CellKey, SegmentRecord>;
  private snakeMeta: Map<string, SnakeMeta>;
  private snakeFoodReachByTurn: Map<string, number[]>;
  private width: number;
  private height: number;
  private config: BoardGraphConfig;
  private currentTurn: number;

  constructor(state: BoardSnapshot, config?: Partial<BoardGraphConfig>) {
    this.width = state.board.width;
    this.height = state.board.height;
    this.config = {
      tailGrowthTiming: 'grow-next-turn',
      maxLookaheadTurns: 5,
      ...config
    };
    this.currentTurn = state.turn ?? 0;

    this.adjacencyList = new Map();
    this.blockedCells = new Set();
    this.hazardCells = new Set();
    this.segmentAt = new Map();
    this.snakeMeta = new Map();
    this.snakeFoodReachByTurn = new Map();

    this.buildGraph(state);
  }

  /**
   * Build the graph in two phases to break a circular dependency: the optimistic
   * (turn-aware) passability needs each segment's conservativeDisappearTurn,
   * which is produced by the food-reach BFS — but that BFS only needs STATIC
   * passability. So we build the static layer first, run food reach over it,
   * then fold the results back in.
   */
  private buildGraph(state: BoardSnapshot): void {
    const { board } = state;

    // Phase 0: per-snake metadata (teams, invulnerability, head/tail keys).
    this.buildSnakeMeta(board.snakes);

    // Phase 1: segments + hazards + static blocked set + adjacency. After this,
    // passabilityFor({ clearance: 'static' }) is fully functional.
    this.buildSegments(board.snakes, board.food, board.hazards);
    this.buildAdjacency();

    // Phase 2: food reach via the static predicate, then fill in each segment's
    // optimistic + conservative disappear turns. After this, the turn-aware
    // clearance layers ('optimistic' and 'conservative') are correct.
    this.calculateSnakeFoodReachability(board.snakes, board.food);
    this.fillDisappearTurns(board.snakes);
  }

  private buildSnakeMeta(snakes: Snake[]): void {
    this.snakeMeta.clear();

    const living = snakes.filter(s => s.health > 0);
    const teams = new TeamDetector().detectTeams(living);
    const teamOf = new Map<string, string>();
    for (const team of teams) {
      for (const s of team.snakes) teamOf.set(s.id, team.color);
    }

    for (const snake of living) {
      this.snakeMeta.set(snake.id, {
        invuln: snake.invulnerabilityLevel ?? 0,
        expiryTurn: snake.invulnerabilityExpiryTurn ?? this.currentTurn,
        teamId: teamOf.get(snake.id) ?? snake.id,
        headKey: this.coordToKey(snake.head),
        tailKey: this.coordToKey(snake.body[snake.body.length - 1])
      });
    }
  }

  private buildSegments(snakes: Snake[], food: Coord[], hazards: Coord[]): void {
    this.segmentAt.clear();
    this.blockedCells.clear();
    this.hazardCells.clear();

    for (const snake of snakes) {
      if (snake.health <= 0) continue;
      const justAte = this.snakeJustAte(snake, food);

      // Body segments, excluding the head at index 0.
      for (let i = 1; i < snake.body.length; i++) {
        const key = this.coordToKey(snake.body[i]);
        const isTail = i === snake.body.length - 1;
        const turnsFromTail = snake.body.length - i;

        let staticBlocked = true;
        if (isTail) {
          if (justAte) {
            // Head on food => snake grows => tail does NOT vacate next turn.
            staticBlocked = true;
          } else if (this.config.tailGrowthTiming === 'grow-same-turn') {
            staticBlocked = false; // tail moves this turn
          } else {
            // grow-next-turn: tail moves unless it's the only segment after head.
            staticBlocked = snake.body.length === 2;
          }
        }

        // Both disappear turns start at the pure-geometry base (turnsFromTail)
        // and are pushed out by fillDisappearTurns once food reach is known.
        this.segmentAt.set(key, {
          snakeId: snake.id,
          isTail,
          optimisticDisappearTurn: turnsFromTail,
          physicalDisappearTurn: turnsFromTail,
          conservativeDisappearTurn: turnsFromTail,
          staticBlocked
        });

        if (staticBlocked) this.blockedCells.add(key);
      }
    }

    for (const hazard of hazards) {
      const key = this.coordToKey(hazard);
      this.hazardCells.add(key);
      this.blockedCells.add(key);
    }
  }

  private buildAdjacency(): void {
    this.adjacencyList.clear();
    for (let x = 0; x < this.width; x++) {
      for (let y = 0; y < this.height; y++) {
        const cellKey = this.coordToKey({ x, y });
        if (this.blockedCells.has(cellKey)) {
          this.adjacencyList.set(cellKey, new Set());
          continue;
        }
        const passableNeighbors = new Set<CellKey>();
        for (const neighbor of this.orthogonal({ x, y })) {
          if (!this.isInBounds(neighbor)) continue;
          const neighborKey = this.coordToKey(neighbor);
          if (!this.blockedCells.has(neighborKey)) {
            passableNeighbors.add(neighborKey);
          }
        }
        this.adjacencyList.set(cellKey, passableNeighbors);
      }
    }
  }

  /**
   * Food reachability from each snake's head via its OWN subjective static
   * passability. Stores the count of NEW food reached at each turn, used to push
   * out conservative disappear turns (a snake that can eat keeps growing).
   */
  private calculateSnakeFoodReachability(snakes: Snake[], food: Coord[]): void {
    this.snakeFoodReachByTurn.clear();
    const foodSet = new Set<CellKey>(food.map(f => this.coordToKey(f)));

    for (const snake of snakes) {
      if (snake.health <= 0) continue;

      // Static clearance so this does not read the disappear turns, which don't
      // exist yet — this is what breaks the build-order cycle.
      const pass = this.passabilityFor(snake.id, { clearance: 'static' }).passable;

      const foodByTurn: number[] = [];
      const visited = new Set<CellKey>();
      visited.add(this.coordToKey(snake.head));
      foodByTurn.push(foodSet.has(this.coordToKey(snake.head)) ? 1 : 0);

      let currentLevel: Coord[] = [snake.head];
      for (let turn = 1; turn <= this.config.maxLookaheadTurns; turn++) {
        const nextLevel: Coord[] = [];
        let foodFoundThisTurn = 0;
        for (const pos of currentLevel) {
          for (const neighbor of this.orthogonal(pos)) {
            if (!this.isInBounds(neighbor)) continue;
            const key = this.coordToKey(neighbor);
            if (visited.has(key)) continue;
            if (!pass(neighbor, turn)) continue;
            visited.add(key);
            nextLevel.push(neighbor);
            if (foodSet.has(key)) foodFoundThisTurn++;
          }
        }
        foodByTurn.push(foodFoundThisTurn);
        currentLevel = nextLevel;
        if (currentLevel.length === 0) break;
      }

      this.snakeFoodReachByTurn.set(snake.id, foodByTurn);
    }
  }

  /**
   * Fill each segment's optimistic + conservative disappear turns from the
   * pure-geometry base (turnsFromTail) and the owner's food reach.
   *
   * Eat accounting is PER SEGMENT: an eat at turn t only delays segments whose
   * (current, already-delayed) vacate turn comes after the eat takes effect.
   * Under 'grow-next-turn' timing an eat at turn t delays only segments whose
   * vacate turn is STRICTLY greater than t (the tail vacating at turn t itself
   * has already moved when the eat lands). Under 'grow-same-turn' the tail
   * stays put on the eating turn itself, so an eat at turn t delays segments
   * whose vacate turn is >= t. Turn-0 "eats" (head already on food — justAte)
   * delay everything, matching the static-layer blocked tail.
   *
   *  - optimistic  = base + only the eats we can CONFIRM: turn 0 (head on
   *    food) and turn 1 (food one step away), applied per segment.
   *  - physical    = base + every food the owner could reach in time to still
   *    be growing when the segment would vacate, applied per segment with NO
   *    safety buffer. Used by the subject-agnostic Voronoi layer.
   *  - conservative = physical + 1. The physical vacate turn plus a one-turn
   *    safety buffer; this is what pessimistic survival reasoning banks on.
   */
  private fillDisappearTurns(snakes: Snake[]): void {
    for (const snake of snakes) {
      if (snake.health <= 0) continue;
      const foodByTurn = this.snakeFoodReachByTurn.get(snake.id) || [];

      // Does an eat at turn t delay a segment currently vacating at `vacate`?
      const eatDelays = (vacate: number, t: number): boolean =>
        this.config.tailGrowthTiming === 'grow-same-turn' ? vacate >= t : vacate > t;

      // Apply eats (count per turn) to a segment's base vacate turn.
      const applyEats = (base: number, eatsAtTurn: (t: number) => number, maxTurn: number): number => {
        let vacate = base;
        for (let t = 0; t <= maxTurn; t++) {
          const eats = eatsAtTurn(t);
          if (eats > 0 && eatDelays(vacate, t)) vacate += eats;
        }
        return vacate;
      };

      // Confirmed eats only: turn 0 = head already on food (justAte); turn 1 =
      // a food cell reachable in a single move this turn.
      const justAte = (foodByTurn[0] ?? 0) > 0 ? 1 : 0;
      const canEatThisTurn = (foodByTurn[1] ?? 0) > 0 ? 1 : 0;
      const confirmedEats = (t: number): number =>
        t === 0 ? justAte : t === 1 ? Math.min(canEatThisTurn, 1) : 0;
      const potentialEats = (t: number): number => foodByTurn[t] ?? 0;

      for (let i = 1; i < snake.body.length; i++) {
        const key = this.coordToKey(snake.body[i]);
        const seg = this.segmentAt.get(key);
        // Skip cells overwritten by another snake's overlapping segment.
        if (!seg || seg.snakeId !== snake.id) continue;

        const base = snake.body.length - i; // pure-geometry disappear turn (turnsFromTail)

        seg.optimisticDisappearTurn = applyEats(base, confirmedEats, 1);

        if (base <= this.config.maxLookaheadTurns) {
          seg.physicalDisappearTurn = applyEats(base, potentialEats, foodByTurn.length - 1);
        } else {
          seg.physicalDisappearTurn = base;
        }
        seg.conservativeDisappearTurn = seg.physicalDisappearTurn + 1;
      }
    }
  }

  private snakeJustAte(snake: Snake, food: Coord[]): boolean {
    return food.some(f => f.x === snake.head.x && f.y === snake.head.y);
  }

  /** Invulnerability level of a snake projected to an absolute game turn. */
  private invulnAt(snakeId: string, absoluteTurn: number): number {
    const meta = this.snakeMeta.get(snakeId);
    if (!meta) return 0;
    return absoluteTurn <= meta.expiryTurn ? meta.invuln : 0;
  }

  private orthogonal(coord: Coord): Coord[] {
    return [
      { x: coord.x, y: coord.y + 1 },
      { x: coord.x, y: coord.y - 1 },
      { x: coord.x - 1, y: coord.y },
      { x: coord.x + 1, y: coord.y }
    ];
  }

  /**
   * The single source of truth for "where can THIS snake walk". Returns a bound
   * predicate plus the subject's head/tail keys.
   *
   * Rules, from the subject's perspective:
   *  - own head: not a destination (it's the BFS origin);
   *  - own interior body: never passable;
   *  - own tail: passable per the vacate rule (it can chase its tail);
   *  - another snake STRICTLY less invulnerable than us (at the arrival turn):
   *    fully severable, so its body is passable;
   *  - other bodies: recede per the chosen `clearance` mode. Enemy-tail risk is
   *    modelled by the conservative clearance timing (which never banks on an
   *    opponent's tail vacating early), not by a separate force-block flag.
   *
   * Severability uses a STRICT inequality (owner < subject): equal invulnerability
   * never grants passage, so we never bank on winning on equal footing.
   */
  passabilityFor(subjectId: string, opts?: PassabilityOptions): SnakePassability {
    const subject = this.snakeMeta.get(subjectId);
    const headKey = subject?.headKey ?? '';
    const tailKey = subject?.tailKey ?? '';
    const clearance: ClearanceMode = opts?.clearance ?? 'static';

    // Has `seg` receded (become passable) by `arrivalTurn` under the clearance
    // mode? Under 'static' only an immediately-vacating tail counts.
    const recededByClearance = (seg: SegmentRecord, arrivalTurn: number): boolean => {
      switch (clearance) {
        case 'static': return !seg.staticBlocked;
        case 'conservative': return seg.conservativeDisappearTurn <= arrivalTurn;
        case 'optimistic': return seg.optimisticDisappearTurn <= arrivalTurn;
      }
    };

    const passable = (coord: Coord, arrivalTurn: number): boolean => {
      if (!this.isInBounds(coord)) return false;
      const key = this.coordToKey(coord);
      if (this.hazardCells.has(key)) return false;
      if (key === headKey) return false; // origin, never a destination

      const seg = this.segmentAt.get(key);
      if (!seg) return true; // empty cell (including other snakes' heads)

      if (seg.snakeId === subjectId) {
        // Our own body: interior is always a wall (we cannot count on our own
        // body vacating ahead of our head); only our tail follows the vacate rule.
        if (!seg.isTail) return false;
        return recededByClearance(seg, arrivalTurn);
      }

      // Another snake's segment. Severable if we strictly out-invulnerate the
      // owner at the turn we would arrive.
      const absTurn = this.currentTurn + arrivalTurn;
      if (this.invulnAt(seg.snakeId, absTurn) < this.invulnAt(subjectId, absTurn)) {
        return true;
      }

      // Otherwise the cell is passable only once the owner's body has receded
      // there under the chosen clearance timing (tail and interior alike).
      return recededByClearance(seg, arrivalTurn);
    };

    return { headKey, tailKey, passable };
  }

  /** Thin convenience wrapper over `passabilityFor` for one-off queries. */
  isPassableForSnake(coord: Coord, arrivalTurn: number, subjectId: string, opts?: PassabilityOptions): boolean {
    return this.passabilityFor(subjectId, opts).passable(coord, arrivalTurn);
  }

  /**
   * Get passable neighbors for a cell (physical, subject-agnostic).
   */
  getNeighbors(coord: Coord): Coord[] {
    const key = this.coordToKey(coord);
    const neighborKeys = this.adjacencyList.get(key);
    if (!neighborKeys) return [];
    return Array.from(neighborKeys).map(k => this.keyToCoord(k));
  }

  /**
   * Get passable neighbors for a cell with optimistic (turn-aware) physical
   * passability: body segments are passable once they will have receded by
   * arrivalTurn. Subject-agnostic (no severability) — used by the shared
   * Voronoi territory BFS.
   */
  getNeighborsOptimistic(coord: Coord, arrivalTurn: number): Coord[] {
    const passable: Coord[] = [];
    for (const neighbor of this.orthogonal(coord)) {
      if (!this.isInBounds(neighbor)) continue;
      if (this.isPassableAtTurn(neighbor, arrivalTurn)) passable.push(neighbor);
    }
    return passable;
  }

  /**
   * Physical turn-aware passability (no severability). For body segments, the
   * cell is passable once its PHYSICAL disappear turn has passed (no survival
   * safety buffer — that buffer belongs to the 'conservative' clearance mode).
   */
  isPassableAtTurn(coord: Coord, arrivalTurn: number): boolean {
    if (!this.isInBounds(coord)) return false;
    const key = this.coordToKey(coord);
    const seg = this.segmentAt.get(key);
    if (seg) {
      if (arrivalTurn <= this.config.maxLookaheadTurns) {
        return seg.physicalDisappearTurn <= arrivalTurn;
      }
      return !this.blockedCells.has(key);
    }
    return !this.blockedCells.has(key);
  }

  /**
   * Check if a coordinate is within board bounds.
   */
  isInBounds(coord: Coord): boolean {
    return coord.x >= 0 && coord.x < this.width &&
           coord.y >= 0 && coord.y < this.height;
  }

  /**
   * Physical static passability (in bounds and not a static wall). No
   * severability — that lives in passabilityFor.
   */
  isPassable(coord: Coord): boolean {
    if (!this.isInBounds(coord)) return false;
    return !this.blockedCells.has(this.coordToKey(coord));
  }

  /**
   * Get the set of blocked cell keys (for direct iteration if needed).
   */
  getBlockedCells(): Set<CellKey> {
    return this.blockedCells;
  }

  /**
   * Convert coordinate to string key.
   */
  coordToKey(coord: Coord): CellKey {
    return `${coord.x},${coord.y}`;
  }

  /**
   * Convert string key to coordinate.
   */
  keyToCoord(key: CellKey): Coord {
    const [x, y] = key.split(',').map(Number);
    return { x, y };
  }

  /**
   * Get all cells in the board.
   */
  getAllCells(): Coord[] {
    const cells: Coord[] = [];
    for (let x = 0; x < this.width; x++) {
      for (let y = 0; y < this.height; y++) {
        cells.push({ x, y });
      }
    }
    return cells;
  }

  /**
   * Get board dimensions.
   */
  getDimensions(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }
}
