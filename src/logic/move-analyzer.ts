/**
 * Unified move analyzer that provides a single source of truth for move safety.
 * Returns both safe moves (definite survival) and risky moves (possible head-to-head death).
 */

import { GameState, Snake, Direction, Coord } from '../types/battlesnake';
import { TurnStateManager } from './turn-state';
import { BoardGraph } from './board-graph';

export interface H2HRiskInfo {
  hasEnemyRisk: boolean;   // Risk of h2h with equal/larger enemy
  hasAllyRisk: boolean;    // Risk of h2h with equal/larger ally
  enemyRiskCount: number;  // Number of threatening enemies
  allyRiskCount: number;   // Number of threatening allies
}

export interface MoveAnalysis {
  safe: Direction[];   // Moves that definitely won't cause death
  risky: Direction[];  // Moves that could result in head-to-head death
  h2hRiskByMove: Map<Direction, H2HRiskInfo>;  // H2H risk details per move
}

export class MoveAnalyzer {
  private tailSafetyRule: 'official' | 'custom';
  
  constructor(tailSafetyRule: 'official' | 'custom' = 'custom') {
    this.tailSafetyRule = tailSafetyRule;
  }
  /**
   * Analyzes available moves for a snake and categorizes them as safe or risky.
   * This is the single source of truth for move safety in the entire codebase.
   * Uses BoardGraph as the single source of truth for passability.
   */
  public analyzeMoves(snake: Snake, gameState: GameState, graph: BoardGraph, teamSnakeIds?: Set<string>): MoveAnalysis {
    // Update turn state to track which snakes ate food
    const turnStateManager = TurnStateManager.getInstance();
    turnStateManager.updateState(
      gameState.game.id, 
      gameState.turn, 
      gameState.board.snakes.map(s => ({id: s.id, length: s.length}))
    );
    const head = snake.head;
    const allDirections: Direction[] = ['up', 'down', 'left', 'right'];
    const safe: Direction[] = [];
    const risky: Direction[] = [];
    const h2hRiskByMove = new Map<Direction, H2HRiskInfo>();

    // Our own subjective passability (walls, hazards, own body, severable enemies).
    const ourPassability = graph.passabilityFor(snake.id);

    // Analyze each possible move
    for (const direction of allDirections) {
      const newPosition = this.getNextPosition(head, direction);
      
      // Check for certain death using the snake's own passability rules
      if (!ourPassability.passable(newPosition, 1)) {
        // This move causes certain death - exclude it entirely
        continue;
      }
      
      // Get detailed head-to-head risk information
      const h2hRisk = this.getHeadToHeadRiskInfo(newPosition, snake, gameState, teamSnakeIds);
      h2hRiskByMove.set(direction, h2hRisk);
      
      // Check for head-to-head risk (any risk = risky move)
      if (h2hRisk.hasEnemyRisk || h2hRisk.hasAllyRisk) {
        risky.push(direction);
      } else {
        safe.push(direction);
      }
    }
    
    return { safe, risky, h2hRiskByMove };
  }
  
  /**
   * Determines whether `snake` would lose or tie a head-to-head against `other`.
   * Invulnerability is the primary decider (a more-invulnerable snake "acts as
   * the bigger snake"); length only matters when invulnerability is equal.
   * Returns true if the head-to-head is risky for `snake` (loss or tie).
   */
  private losesHeadToHead(snake: Snake, other: Snake): boolean {
    const ourInvulnerability = snake.invulnerabilityLevel ?? 0;
    const theirInvulnerability = other.invulnerabilityLevel ?? 0;
    
    if (ourInvulnerability > theirInvulnerability) return false; // We win outright
    if (ourInvulnerability < theirInvulnerability) return true;  // We lose outright
    
    // Equal invulnerability: length decides; loss (smaller) or tie (equal) is risky
    return snake.length <= other.length;
  }
  
  /**
   * Gets detailed head-to-head risk information for a position.
   * Distinguishes between enemy and ally h2h risks.
   */
  private getHeadToHeadRiskInfo(position: Coord, snake: Snake, gameState: GameState, teamSnakeIds?: Set<string>): H2HRiskInfo {
    const { board } = gameState;
    const result: H2HRiskInfo = {
      hasEnemyRisk: false,
      hasAllyRisk: false,
      enemyRiskCount: 0,
      allyRiskCount: 0
    };
    
    for (const otherSnake of board.snakes) {
      // Skip ourselves and dead snakes
      if (otherSnake.id === snake.id || otherSnake.health <= 0) continue;
      
      // Check if other snake's head is adjacent to our potential position
      const otherHead = otherSnake.head;
      const distance = Math.abs(position.x - otherHead.x) + Math.abs(position.y - otherHead.y);
      
      if (distance === 1) {
        // Other snake could move to our position next turn.
        const isAlly = teamSnakeIds?.has(otherSnake.id) ?? false;

        if (isAlly) {
          // Never pursue a head-to-head with a teammate, even one we would win.
          // Walking head-on into an ally is always treated as a risky/undesirable
          // move, regardless of which snake would survive the collision.
          result.hasAllyRisk = true;
          result.allyRiskCount++;
        } else if (this.losesHeadToHead(snake, otherSnake)) {
          // Enemy: only risky when we wouldn't win outright. Invulnerability
          // decides first; length only when invulnerability is equal. If we
          // out-invulnerate the enemy, the head-to-head is NOT risky (a win).
          result.hasEnemyRisk = true;
          result.enemyRiskCount++;
        }
      }
    }
    
    return result;
  }
  
  /**
   * Gets the next position given a current position and direction.
   */
  private getNextPosition(position: Coord, direction: Direction): Coord {
    switch (direction) {
      case 'up':
        return { x: position.x, y: position.y + 1 };
      case 'down':
        return { x: position.x, y: position.y - 1 };
      case 'left':
        return { x: position.x - 1, y: position.y };
      case 'right':
        return { x: position.x + 1, y: position.y };
    }
  }
}