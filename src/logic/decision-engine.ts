/**
 * Decision engine that orchestrates the principled architecture for move selection.
 * Uses MoveAnalyzer for move enumeration and BoardEvaluator for scoring.
 */

import { GameState, Snake, Direction, Coord } from '../types/battlesnake';
import { MoveAnalyzer, MoveAnalysis, H2HRiskInfo } from './move-analyzer';
import { BoardEvaluator, BoardEvaluation, EvaluationContext, WaypointContext } from './board-evaluator';
import { Simulator } from './simulator';
import { BoardGraph } from './board-graph';
import { MultiSourceBFS, BFSSource } from './multi-source-bfs';

export interface MoveDecision {
  move: Direction;
  candidateMoves: Direction[];  // The actual moves we evaluated (all non-lethal moves)
  evaluations: MoveEvaluationResult[];
  h2hRiskByMove: Map<Direction, H2HRiskInfo>;  // H2H risk info for each move
}

export interface MoveEvaluationResult {
  move: Direction;
  averageScore: number;
  numStates: number;
  averageBreakdown: BoardEvaluation;
  projectedTerritoryCells?: { [snakeId: string]: { x: number; y: number }[] };
}

export interface DecisionConfig {
  maxSimulationDepth: number;
  timeoutMs: number;
  nearbyDistance: number;  // Focal distance: snakes within this Manhattan distance have all moves enumerated; snakes beyond are frozen
  tailSafetyRule?: 'official' | 'custom';  // Rule variant for tail safety
  tailGrowthTiming?: 'grow-same-turn' | 'grow-next-turn';  // When snake grows after eating
  weights?: {
    // My snake weights
    myLength?: number;
    myTerritory?: number;
    myControlledFood?: number;
    // Team weights
    teamLength?: number;
    teamTerritory?: number;
    teamControlledFood?: number;
    // Distance/proximity weights
    foodProximity?: number;
    // Enemy weights
    enemyTerritory?: number;
    enemyLength?: number;
    // Life/death weights
    kills?: number;
    deaths?: number;
    // Head-to-head risk weights
    enemyH2HRisk?: number;
    allyH2HRisk?: number;
    // Waypoint weights
    waypointGoto?: number;
    waypointNear?: number;
  };
}

export class DecisionEngine {
  private moveAnalyzer: MoveAnalyzer;
  private boardEvaluator: BoardEvaluator;
  private simulator: Simulator;
  private config: DecisionConfig;
  private lastFoodSetByGameId: Map<string, Set<string>> = new Map();
  private static readonly MAX_FOOD_SET_ENTRIES = 20;
  
  constructor(config?: Partial<DecisionConfig>) {
    this.config = {
      maxSimulationDepth: 1,
      timeoutMs: 400,
      nearbyDistance: 5,
      tailSafetyRule: 'custom',
      tailGrowthTiming: 'grow-next-turn',
      ...config
    };
    
    this.moveAnalyzer = new MoveAnalyzer(this.config.tailSafetyRule);
    this.boardEvaluator = new BoardEvaluator(
      this.config.weights,
      { tailGrowthTiming: this.config.tailGrowthTiming }
    );
    this.simulator = new Simulator();
  }
  
  /**
   * Main decision method that selects the best move for our snake.
   * Now considers all non-lethal moves (safe + risky) and applies h2h risk penalties.
   */
  public decide(gameState: GameState, teamSnakeIds: Set<string>, waypoint?: WaypointContext | null): MoveDecision {
    const startTime = Date.now();
    const gameId = gameState.game.id;
    
    // Get previous food positions for this game
    const prevFoodSet = this.lastFoodSetByGameId.get(gameId);
    
    // Build current food set for simulated evaluations
    const currentFoodSet = new Set<string>();
    for (const food of gameState.board.food) {
      currentFoodSet.add(`${food.x},${food.y}`);
    }
    
    // Create BoardGraph once for this turn - single source of truth for passability
    const graph = new BoardGraph(gameState, { tailGrowthTiming: this.config.tailGrowthTiming });
    
    // Get move analysis with h2h risk details
    const moveAnalysis = this.moveAnalyzer.analyzeMoves(gameState.you, gameState, graph, teamSnakeIds);
    
    // Consider ALL non-lethal moves (safe + risky) - h2h risk is now a weighted penalty
    let ourMoves = [...moveAnalysis.safe, ...moveAnalysis.risky];
    
    // Deterministic ally-collision veto: a head-to-head with a teammate is only
    // ever something to avoid, never to pursue. If any candidate move does NOT
    // collide head-on with an ally, drop every ally-colliding candidate before
    // scoring so the bot can never choose to walk into a teammate's head when an
    // alternative exists. Enemy head-to-head behaviour is untouched.
    const nonAllyMoves = ourMoves.filter(
      move => !(moveAnalysis.h2hRiskByMove.get(move)?.hasAllyRisk ?? false)
    );
    if (nonAllyMoves.length > 0) {
      ourMoves = nonAllyMoves;
    }
    
    if (ourMoves.length === 0) {
      // No moves available - we're dead
      return {
        move: 'up',
        candidateMoves: [],
        evaluations: [],
        h2hRiskByMove: new Map()
      };
    }
    
    if (ourMoves.length === 1) {
      // Only one move available - still evaluate it properly
      const h2hRisk = moveAnalysis.h2hRiskByMove.get(ourMoves[0]);
      const evaluation = this.boardEvaluator.evaluateBoard(
        gameState, 
        gameState.you.id, 
        teamSnakeIds,
        { 
          prevFoodSet,
          h2hRisk: {
            enemyH2HRisk: h2hRisk?.hasEnemyRisk ? 1 : 0,
            allyH2HRisk: h2hRisk?.hasAllyRisk ? 1 : 0
          },
          waypoint
        }
      );
      
      // Compute projected territory for the single move
      const singleMovePos = this.getMovePosition(gameState.you.head, ourMoves[0]);
      const singleProjSources: BFSSource[] = [{
        id: gameState.you.id,
        position: singleMovePos,
        isTeam: true,
        startDelay: 1
      }];
      for (const snake of gameState.board.snakes) {
        if (snake.id === gameState.you.id || snake.health <= 0) continue;
        singleProjSources.push({
          id: snake.id,
          position: snake.head,
          isTeam: teamSnakeIds.has(snake.id),
          startDelay: 0
        });
      }
      const singleProjBfs = new MultiSourceBFS(graph);
      const singleProjResult = singleProjBfs.compute(singleProjSources, gameState.board.food, undefined, gameState.board.fertileTiles);
      const singleProjTerritory: { [snakeId: string]: { x: number; y: number }[] } = {};
      for (const [snakeId, cells] of singleProjResult.territoryCells) {
        singleProjTerritory[snakeId] = cells;
      }
      
      // Update food set for next turn
      this.setLastFoodSet(gameId, currentFoodSet);
      
      return {
        move: ourMoves[0],
        candidateMoves: ourMoves,
        evaluations: [{
          move: ourMoves[0],
          averageScore: evaluation.score,
          numStates: 1,
          averageBreakdown: evaluation,
          projectedTerritoryCells: singleProjTerritory
        }],
        h2hRiskByMove: moveAnalysis.h2hRiskByMove
      };
    }
    
    // Enumerate possible board states
    const boardStates = this.enumerateBoardStates(gameState, ourMoves, teamSnakeIds, startTime, graph);
    
    // Evaluate each of our candidate moves
    const evaluations: MoveEvaluationResult[] = [];
    
    for (const move of ourMoves) {
      const moveStates = boardStates.filter(state => state.ourMove === move);
      
      // Get h2h risk for this move
      const h2hRisk = moveAnalysis.h2hRiskByMove.get(move);
      const h2hRiskCtx = {
        enemyH2HRisk: h2hRisk?.hasEnemyRisk ? 1 : 0,
        allyH2HRisk: h2hRisk?.hasAllyRisk ? 1 : 0
      };
      
      if (moveStates.length === 0) {
        // This shouldn't happen but handle gracefully
        evaluations.push({
          move,
          averageScore: -1000,
          numStates: 0,
          averageBreakdown: this.boardEvaluator.evaluateBoard(
            gameState, 
            gameState.you.id, 
            teamSnakeIds,
            { prevFoodSet, h2hRisk: h2hRiskCtx, waypoint }
          )
        });
        continue;
      }
      
      // Average the evaluations for this move
      let totalScore = 0;
      const allEvaluations: BoardEvaluation[] = [];
      
      for (const state of moveStates) {
        const evaluation = this.boardEvaluator.evaluateBoard(
          state.gameState, 
          gameState.you.id, 
          teamSnakeIds,
          { 
            prevFoodSet: currentFoodSet,  // Current food is "previous" from simulated state's perspective
            h2hRisk: h2hRiskCtx,  // Pass h2h risk to evaluator
            simulatedSnakeIds: state.simulatedSnakeIds,  // Snakes that were simulated get startDelay: 1
            waypoint
          }
        );
        totalScore += evaluation.score;
        allEvaluations.push(evaluation);
      }
      
      const averageScore = totalScore / moveStates.length;
      
      // Calculate average breakdown
      const averageBreakdown = this.averageEvaluations(allEvaluations);
      
      evaluations.push({
        move,
        averageScore,
        numStates: moveStates.length,
        averageBreakdown
      });
    }
    
    // Select the best move with a candidate-level fatal-pocket veto.
    // A move whose averaged `trapped` signal is at/above the fatal threshold leads
    // into a clearly-fatal dead-end pocket (no tail-chase, not enough room to
    // outlast our length). We must never pick such a move when a non-fatal
    // alternative exists — even if the pocket happens to score higher (e.g. a
    // waypoint sitting inside it). This is the hard guarantee on top of the
    // strongly-negative `trapped` weight. If EVERY candidate is fatal, we fall
    // back to scoring among all of them (least-bad death).
    const FATAL_TRAP_THRESHOLD = 0.5;
    const nonFatal = evaluations.filter(e => e.averageBreakdown.stats.trapped < FATAL_TRAP_THRESHOLD);
    const selectionPool = nonFatal.length > 0 ? nonFatal : evaluations;
    
    let bestMove = selectionPool[0].move;
    let bestScore = -Infinity;
    for (const evalResult of selectionPool) {
      if (evalResult.averageScore > bestScore) {
        bestScore = evalResult.averageScore;
        bestMove = evalResult.move;
      }
    }
    
    // Compute projected territory per move (asymmetric BFS)
    const teamSnakeIdsForBFS = new Set<string>();
    const teams = gameState.board.snakes.filter((s: Snake) => s.health > 0 && teamSnakeIds.has(s.id));
    for (const s of teams) teamSnakeIdsForBFS.add(s.id);
    
    for (const evalResult of evaluations) {
      const candidatePos = this.getMovePosition(gameState.you.head, evalResult.move);
      if (!candidatePos) continue;
      
      const projSources: BFSSource[] = [];
      projSources.push({
        id: gameState.you.id,
        position: candidatePos,
        isTeam: true,
        startDelay: 1
      });
      
      for (const snake of gameState.board.snakes) {
        if (snake.id === gameState.you.id || snake.health <= 0) continue;
        projSources.push({
          id: snake.id,
          position: snake.head,
          isTeam: teamSnakeIds.has(snake.id),
          startDelay: 0
        });
      }
      
      const projBfs = new MultiSourceBFS(graph);
      const projResult = projBfs.compute(projSources, gameState.board.food, undefined, gameState.board.fertileTiles);
      
      const projTerritoryCells: { [snakeId: string]: { x: number; y: number }[] } = {};
      for (const [snakeId, cells] of projResult.territoryCells) {
        projTerritoryCells[snakeId] = cells;
      }
      evalResult.projectedTerritoryCells = projTerritoryCells;
    }
    
    // Update food set for next turn (with LRU cap to avoid unbounded growth)
    this.setLastFoodSet(gameId, currentFoodSet);
    
    return {
      move: bestMove,
      candidateMoves: ourMoves,
      evaluations,
      h2hRiskByMove: moveAnalysis.h2hRiskByMove
    };
  }
  
  /**
   * Called when a game ends. Releases per-game state so it doesn't leak.
   */
  public onGameEnd(gameId: string): void {
    this.lastFoodSetByGameId.delete(gameId);
  }

  /**
   * Set the last-food-set for a game, capping the map to MAX_FOOD_SET_ENTRIES
   * via LRU eviction (oldest insertion key first). Belt-and-suspenders against
   * the case where /end never arrives for some game.
   */
  private setLastFoodSet(gameId: string, foodSet: Set<string>): void {
    // Re-insert to refresh insertion order for LRU.
    if (this.lastFoodSetByGameId.has(gameId)) {
      this.lastFoodSetByGameId.delete(gameId);
    }
    this.lastFoodSetByGameId.set(gameId, foodSet);
    while (this.lastFoodSetByGameId.size > DecisionEngine.MAX_FOOD_SET_ENTRIES) {
      const oldest = this.lastFoodSetByGameId.keys().next().value;
      if (oldest === undefined) break;
      this.lastFoodSetByGameId.delete(oldest);
    }
  }

  /**
   * Get candidate moves for our snake using the principled rule:
   * Use safe moves if available, otherwise use all risky moves.
   */
  private getOurCandidateMoves(snake: Snake, gameState: GameState, graph: BoardGraph): Direction[] {
    const analysis = this.moveAnalyzer.analyzeMoves(snake, gameState, graph);
    
    // Use safe moves if available, otherwise use risky moves
    if (analysis.safe.length > 0) {
      return analysis.safe;
    } else {
      return analysis.risky;
    }
  }
  
  /**
   * Get candidate moves for other snakes.
   * All non-death moves (safe + risky) are considered.
   */
  private getOtherSnakeCandidateMoves(snake: Snake, gameState: GameState, graph: BoardGraph): Direction[] {
    const analysis = this.moveAnalyzer.analyzeMoves(snake, gameState, graph);
    
    // Other snakes consider all non-death moves
    return [...analysis.safe, ...analysis.risky];
  }
  
  /**
   * Enumerate possible board states based on move combinations.
   */
  private enumerateBoardStates(
    gameState: GameState, 
    ourMoves: Direction[], 
    teamSnakeIds: Set<string>,
    startTime: number,
    graph: BoardGraph
  ): { ourMove: Direction; gameState: GameState; simulatedSnakeIds: Set<string> }[] {
    
    const results: { ourMove: Direction; gameState: GameState; simulatedSnakeIds: Set<string> }[] = [];
    const { board } = gameState;
    
    // Identify nearby snakes within focal distance for full move enumeration
    // Distant snakes (outside nearbyDistance) are frozen and not simulated
    const nearbySnakes: Snake[] = [];
    
    for (const snake of board.snakes) {
      if (snake.id === gameState.you.id || snake.health <= 0) continue;
      
      const distance = this.manhattanDistance(gameState.you.head, snake.head);
      if (distance <= this.config.nearbyDistance) {
        nearbySnakes.push(snake);
      }
      // Snakes beyond nearbyDistance are frozen (not included in simulation)
    }
    
    // Build the set of simulated snake IDs (our snake + nearby snakes)
    const simulatedSnakeIds = new Set<string>([gameState.you.id]);
    for (const snake of nearbySnakes) {
      simulatedSnakeIds.add(snake.id);
    }
    
    // For each of our moves
    for (const ourMove of ourMoves) {
      // Check time budget
      if (Date.now() - startTime > this.config.timeoutMs) {
        break;
      }
      
      // Generate move combinations for nearby snakes
      const nearbyMoveSets = this.generateNearbyMoveSets(nearbySnakes, gameState, graph);
      
      // For each nearby move combination
      for (const nearbyMoveSet of nearbyMoveSets) {
        // Check time budget
        if (Date.now() - startTime > this.config.timeoutMs) {
          break;
        }
        
        // Create full move set
        const fullMoveSet = new Map<string, Direction>();
        fullMoveSet.set(gameState.you.id, ourMove);
        
        // Add nearby snake moves
        for (const [snakeId, move] of nearbyMoveSet) {
          fullMoveSet.set(snakeId, move);
        }
        
        // Distant snakes are frozen (not included in move set) to avoid
        // noise from random move selection affecting board evaluation
        
        // Simulate the board state
        const simulatedBoard = this.simulator.simulateNextBoardState(gameState, fullMoveSet, teamSnakeIds);
        
        // Construct new GameState from simulated board
        const nextGameState: GameState = {
          game: gameState.game,
          turn: gameState.turn + 1,
          board: simulatedBoard.board,
          you: simulatedBoard.board.snakes.find(s => s.id === gameState.you.id) || gameState.you
        };
        
        results.push({
          ourMove,
          gameState: nextGameState,
          simulatedSnakeIds
        });
      }
    }
    
    return results;
  }
  
  /**
   * Generate all possible move combinations for nearby snakes.
   */
  private generateNearbyMoveSets(
    nearbySnakes: Snake[], 
    gameState: GameState,
    graph: BoardGraph
  ): Map<string, Direction>[] {
    
    if (nearbySnakes.length === 0) {
      return [new Map()]; // Single empty move set
    }
    
    // Get candidate moves for each nearby snake
    const snakeMovesMap = new Map<string, Direction[]>();
    for (const snake of nearbySnakes) {
      const moves = this.getOtherSnakeCandidateMoves(snake, gameState, graph);
      if (moves.length > 0) {
        snakeMovesMap.set(snake.id, moves);
      }
    }
    
    // Generate all combinations
    const moveSets: Map<string, Direction>[] = [];
    this.generateCombinations(
      Array.from(snakeMovesMap.entries()),
      0,
      new Map(),
      moveSets
    );
    
    return moveSets;
  }
  
  /**
   * Recursive helper to generate move combinations.
   */
  private generateCombinations(
    snakeMoves: [string, Direction[]][],
    index: number,
    current: Map<string, Direction>,
    results: Map<string, Direction>[]
  ): void {
    if (index >= snakeMoves.length) {
      results.push(new Map(current));
      return;
    }
    
    const [snakeId, moves] = snakeMoves[index];
    for (const move of moves) {
      current.set(snakeId, move);
      this.generateCombinations(snakeMoves, index + 1, current, results);
    }
  }
  
  /**
   * Calculate Manhattan distance between two coordinates.
   */
  private manhattanDistance(a: Coord, b: Coord): number {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  }
  
  private getMovePosition(head: Coord, direction: Direction): Coord {
    switch (direction) {
      case 'up': return { x: head.x, y: head.y + 1 };
      case 'down': return { x: head.x, y: head.y - 1 };
      case 'left': return { x: head.x - 1, y: head.y };
      case 'right': return { x: head.x + 1, y: head.y };
    }
  }
  
  /**
   * Average multiple board evaluations.
   */
  private averageEvaluations(evaluations: BoardEvaluation[]): BoardEvaluation {
    if (evaluations.length === 0) {
      throw new Error('Cannot average empty evaluations');
    }
    
    // Sum all stats
    const sumStats = {
      myLength: 0,
      myTerritory: 0,
      myControlledFood: 0,
      myControlledFertile: 0,
      teamLength: 0,
      teamTerritory: 0,
      teamControlledFood: 0,
      foodDistance: 0,
      foodProximity: 0,
      foodEaten: 0,
      enemyTerritory: 0,
      enemyLength: 0,
      edgePenalty: 0,
      selfSpace: 0,
      alliesEnoughSpace: 0,
      opponentsEnoughSpace: 0,
      kills: 0,
      deaths: 0,
      enemyH2HRisk: 0,
      allyH2HRisk: 0,
      waypointGoto: 0,
      waypointNear: 0,
      aggression: 0,
      trapped: 0
    };
    
    const sumWeighted = {
      myLengthScore: 0,
      myTerritoryScore: 0,
      myControlledFoodScore: 0,
      myControlledFertileScore: 0,
      teamLengthScore: 0,
      teamTerritoryScore: 0,
      teamControlledFoodScore: 0,
      foodProximityScore: 0,
      foodEatenScore: 0,
      enemyTerritoryScore: 0,
      enemyLengthScore: 0,
      edgePenaltyScore: 0,
      selfSpaceScore: 0,
      alliesEnoughSpaceScore: 0,
      opponentsEnoughSpaceScore: 0,
      killsScore: 0,
      deathsScore: 0,
      enemyH2HRiskScore: 0,
      allyH2HRiskScore: 0,
      waypointGotoScore: 0,
      waypointNearScore: 0,
      aggressionScore: 0,
      trappedScore: 0
    };
    
    let totalScore = 0;
    
    for (const evaluation of evaluations) {
      // Sum stats
      sumStats.myLength += evaluation.stats.myLength;
      sumStats.myTerritory += evaluation.stats.myTerritory;
      sumStats.myControlledFood += evaluation.stats.myControlledFood;
      sumStats.myControlledFertile += evaluation.stats.myControlledFertile;
      sumStats.teamLength += evaluation.stats.teamLength;
      sumStats.teamTerritory += evaluation.stats.teamTerritory;
      sumStats.teamControlledFood += evaluation.stats.teamControlledFood;
      sumStats.foodDistance += evaluation.stats.foodDistance;
      sumStats.foodProximity += evaluation.stats.foodProximity;
      sumStats.foodEaten += evaluation.stats.foodEaten;
      sumStats.enemyTerritory += evaluation.stats.enemyTerritory;
      sumStats.enemyLength += evaluation.stats.enemyLength;
      sumStats.edgePenalty += evaluation.stats.edgePenalty;
      sumStats.selfSpace += evaluation.stats.selfSpace;
      sumStats.alliesEnoughSpace += evaluation.stats.alliesEnoughSpace;
      sumStats.opponentsEnoughSpace += evaluation.stats.opponentsEnoughSpace;
      sumStats.kills += evaluation.stats.kills;
      sumStats.deaths += evaluation.stats.deaths;
      sumStats.enemyH2HRisk += evaluation.stats.enemyH2HRisk;
      sumStats.allyH2HRisk += evaluation.stats.allyH2HRisk;
      sumStats.waypointGoto += evaluation.stats.waypointGoto;
      sumStats.waypointNear += evaluation.stats.waypointNear;
      sumStats.aggression += evaluation.stats.aggression;
      sumStats.trapped += evaluation.stats.trapped;
      
      // Sum weighted scores
      sumWeighted.myLengthScore += evaluation.weighted.myLengthScore;
      sumWeighted.myTerritoryScore += evaluation.weighted.myTerritoryScore;
      sumWeighted.myControlledFoodScore += evaluation.weighted.myControlledFoodScore;
      sumWeighted.myControlledFertileScore += evaluation.weighted.myControlledFertileScore;
      sumWeighted.teamLengthScore += evaluation.weighted.teamLengthScore;
      sumWeighted.teamTerritoryScore += evaluation.weighted.teamTerritoryScore;
      sumWeighted.teamControlledFoodScore += evaluation.weighted.teamControlledFoodScore;
      sumWeighted.foodProximityScore += evaluation.weighted.foodProximityScore;
      sumWeighted.foodEatenScore += evaluation.weighted.foodEatenScore;
      sumWeighted.enemyTerritoryScore += evaluation.weighted.enemyTerritoryScore;
      sumWeighted.enemyLengthScore += evaluation.weighted.enemyLengthScore;
      sumWeighted.edgePenaltyScore += evaluation.weighted.edgePenaltyScore;
      sumWeighted.selfSpaceScore += evaluation.weighted.selfSpaceScore;
      sumWeighted.alliesEnoughSpaceScore += evaluation.weighted.alliesEnoughSpaceScore;
      sumWeighted.opponentsEnoughSpaceScore += evaluation.weighted.opponentsEnoughSpaceScore;
      sumWeighted.killsScore += evaluation.weighted.killsScore;
      sumWeighted.deathsScore += evaluation.weighted.deathsScore;
      sumWeighted.enemyH2HRiskScore += evaluation.weighted.enemyH2HRiskScore;
      sumWeighted.allyH2HRiskScore += evaluation.weighted.allyH2HRiskScore;
      sumWeighted.waypointGotoScore += evaluation.weighted.waypointGotoScore;
      sumWeighted.waypointNearScore += evaluation.weighted.waypointNearScore;
      sumWeighted.aggressionScore += evaluation.weighted.aggressionScore;
      sumWeighted.trappedScore += evaluation.weighted.trappedScore;
      
      totalScore += evaluation.score;
    }
    
    const count = evaluations.length;
    
    // Return averaged evaluation
    return {
      score: totalScore / count,
      stats: {
        myLength: sumStats.myLength / count,
        myTerritory: sumStats.myTerritory / count,
        myControlledFood: sumStats.myControlledFood / count,
        myControlledFertile: sumStats.myControlledFertile / count,
        teamLength: sumStats.teamLength / count,
        teamTerritory: sumStats.teamTerritory / count,
        teamControlledFood: sumStats.teamControlledFood / count,
        foodDistance: sumStats.foodDistance / count,
        foodProximity: sumStats.foodProximity / count,
        foodEaten: sumStats.foodEaten / count,
        enemyTerritory: sumStats.enemyTerritory / count,
        enemyLength: sumStats.enemyLength / count,
        edgePenalty: sumStats.edgePenalty / count,
        selfSpace: sumStats.selfSpace / count,
        alliesEnoughSpace: sumStats.alliesEnoughSpace / count,
        opponentsEnoughSpace: sumStats.opponentsEnoughSpace / count,
        kills: sumStats.kills / count,
        deaths: sumStats.deaths / count,
        enemyH2HRisk: sumStats.enemyH2HRisk / count,
        allyH2HRisk: sumStats.allyH2HRisk / count,
        waypointGoto: sumStats.waypointGoto / count,
        waypointNear: sumStats.waypointNear / count,
        aggression: sumStats.aggression / count,
        trapped: sumStats.trapped / count
      },
      weights: evaluations[0].weights, // All evaluations use same weights
      weighted: {
        myLengthScore: sumWeighted.myLengthScore / count,
        myTerritoryScore: sumWeighted.myTerritoryScore / count,
        myControlledFoodScore: sumWeighted.myControlledFoodScore / count,
        myControlledFertileScore: sumWeighted.myControlledFertileScore / count,
        teamLengthScore: sumWeighted.teamLengthScore / count,
        teamTerritoryScore: sumWeighted.teamTerritoryScore / count,
        teamControlledFoodScore: sumWeighted.teamControlledFoodScore / count,
        foodProximityScore: sumWeighted.foodProximityScore / count,
        foodEatenScore: sumWeighted.foodEatenScore / count,
        enemyTerritoryScore: sumWeighted.enemyTerritoryScore / count,
        enemyLengthScore: sumWeighted.enemyLengthScore / count,
        edgePenaltyScore: sumWeighted.edgePenaltyScore / count,
        selfSpaceScore: sumWeighted.selfSpaceScore / count,
        alliesEnoughSpaceScore: sumWeighted.alliesEnoughSpaceScore / count,
        opponentsEnoughSpaceScore: sumWeighted.opponentsEnoughSpaceScore / count,
        killsScore: sumWeighted.killsScore / count,
        deathsScore: sumWeighted.deathsScore / count,
        enemyH2HRiskScore: sumWeighted.enemyH2HRiskScore / count,
        allyH2HRiskScore: sumWeighted.allyH2HRiskScore / count,
        waypointGotoScore: sumWeighted.waypointGotoScore / count,
        waypointNearScore: sumWeighted.waypointNearScore / count,
        aggressionScore: sumWeighted.aggressionScore / count,
        trappedScore: sumWeighted.trappedScore / count
      }
    };
  }
}