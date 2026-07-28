import { Board, Coord, Direction, GameState, Snake } from '../types/battlesnake';

// MoveSet type definition (previously from move-enumerator)
export type MoveSet = Map<string, Direction>;

export interface SimulatedBoardState {
  board: Board;
  deadSnakeIds: Set<string>;
}

export class Simulator {
  /**
   * Simulate the next board state given a set of moves for all snakes
   */
  public simulateNextBoardState(
    gameState: GameState,
    moveSet: MoveSet,
    teamSnakeIds?: Set<string>
  ): SimulatedBoardState {
    // Deep copy the board
    const newBoard = this.deepCopyBoard(gameState.board);
    const deadSnakeIds = new Set<string>();
    
    // Track new head positions for collision detection
    const newHeadPositions = new Map<string, Coord>();
    const headCollisions = new Map<string, string[]>(); // position -> snake ids
    
    // Step 1: Move all snake heads
    for (const snake of newBoard.snakes) {
      if (!this.isAlive(snake)) {
        deadSnakeIds.add(snake.id);
        continue;
      }
      
      const move = moveSet.get(snake.id);
      if (!move) continue; // Skip if no move provided
      
      const newHead = this.getNewHead(snake.head, move);
      newHeadPositions.set(snake.id, newHead);
      
      // Track potential head-to-head collisions
      const posKey = `${newHead.x},${newHead.y}`;
      if (!headCollisions.has(posKey)) {
        headCollisions.set(posKey, []);
      }
      headCollisions.get(posKey)!.push(snake.id);
    }
    
    // Step 2: Resolve head-to-head collisions
    for (const [, snakeIds] of headCollisions.entries()) {
      if (snakeIds.length > 1) {
        // Multiple snakes moved to same position
        const collidingSnakes = snakeIds.map(id => 
          newBoard.snakes.find(s => s.id === id)!
        );
        
        // Invulnerability decides head-to-head first: a more-invulnerable snake
        // "acts as the bigger snake" and wins regardless of length. Length is only
        // the tiebreaker among snakes sharing the top invulnerability level.
        const maxInvulnerability = Math.max(...collidingSnakes.map(s => s.invulnerabilityLevel ?? 0));
        const topInvulnerable = collidingSnakes.filter(s => (s.invulnerabilityLevel ?? 0) === maxInvulnerability);
        
        // Among the most-invulnerable snakes, the longest survives
        const maxLength = Math.max(...topInvulnerable.map(s => s.length));
        const survivors = topInvulnerable.filter(s => s.length === maxLength);
        
        // Determine who dies in this collision group under standard resolution.
        const groupDead = new Set<string>();
        if (survivors.length > 1) {
          // No unique survivor (tie among equal-invulnerability, equal-length
          // snakes) — all colliding snakes die.
          for (const snake of collidingSnakes) {
            groupDead.add(snake.id);
          }
        } else {
          // Single survivor; every other colliding snake dies.
          const survivorId = survivors[0].id;
          for (const snake of collidingSnakes) {
            if (snake.id !== survivorId) {
              groupDead.add(snake.id);
            }
          }
        }
        
        // Team-awareness: never let our snake benefit from a teammate's
        // head-to-head death. If our snake would survive this collision while a
        // teammate dies in it, flip the outcome — our snake dies and teammates
        // are spared — so the evaluated move gains no territory/space from
        // eliminating an ally. Enemy collision resolution is left unchanged.
        if (teamSnakeIds) {
          const ourId = gameState.you.id;
          const ourSurvives = snakeIds.includes(ourId) && !groupDead.has(ourId);
          const allyDies = snakeIds.some(
            id => id !== ourId && teamSnakeIds.has(id) && groupDead.has(id)
          );
          if (ourSurvives && allyDies) {
            groupDead.add(ourId);
            for (const id of snakeIds) {
              if (id !== ourId && teamSnakeIds.has(id)) {
                groupDead.delete(id);
              }
            }
          }
        }
        
        for (const id of groupDead) {
          deadSnakeIds.add(id);
        }
      }
    }
    
    // Step 3: Check for wall and body collisions
    for (const [snakeId, newHead] of newHeadPositions.entries()) {
      if (deadSnakeIds.has(snakeId)) continue;
      
      // Check wall collision
      if (newHead.x < 0 || newHead.x >= newBoard.width ||
          newHead.y < 0 || newHead.y >= newBoard.height) {
        deadSnakeIds.add(snakeId);
        continue;
      }
      
      // Find the moving snake to check its invulnerability level
      const movingSnake = newBoard.snakes.find(s => s.id === snakeId);
      const movingInvulnerability = movingSnake ? (movingSnake.invulnerabilityLevel ?? 0) : 0;
      
      // Check body collision (including other snakes)
      for (const snake of newBoard.snakes) {
        if (!this.isAlive(snake) || deadSnakeIds.has(snake.id)) continue;
        
        // If moving into a foreign snake's body and we have higher invulnerability, skip collision
        if (snake.id !== snakeId &&
            movingInvulnerability > (snake.invulnerabilityLevel ?? 0)) {
          continue;
        }
        
        // Check collision with each body segment
        for (let i = 0; i < snake.body.length; i++) {
          const segment = snake.body[i];
          
          // Skip tail if it's about to move (and snake isn't eating)
          if (i === snake.body.length - 1) {
            // Check if snake will eat at its NEW position
            const snakeNewHead = newHeadPositions.get(snake.id);
            const willEat = snakeNewHead ? (gameState.board.food ?? []).some(f => 
              f.x === snakeNewHead.x && f.y === snakeNewHead.y
            ) : false;
            
            if (!willEat && snake.id !== snakeId) continue;
            // Allow moving into own tail if not eating
            if (snake.id === snakeId && !willEat) continue;
          }
          
          if (segment.x === newHead.x && segment.y === newHead.y) {
            deadSnakeIds.add(snakeId);
            break;
          }
        }
      }
    }
    
    // Step 4: Update snake positions for surviving snakes
    for (const snake of newBoard.snakes) {
      if (deadSnakeIds.has(snake.id)) continue;
      
      const newHead = newHeadPositions.get(snake.id);
      if (!newHead) continue;
      
      // Check if snake is eating
      const foodIndex = newBoard.food.findIndex(f => 
        f.x === newHead.x && f.y === newHead.y
      );
      const isEating = foodIndex !== -1;
      
      // Update body
      const newBody = [newHead, ...snake.body];
      if (!isEating) {
        newBody.pop(); // Remove tail if not eating
      } else {
        // Remove the eaten food
        newBoard.food.splice(foodIndex, 1);
        snake.health = 100; // Reset health when eating
      }
      
      // Update snake
      snake.head = newHead;
      snake.body = newBody;
      snake.length = newBody.length;
      
      // Decrease health if not eating
      if (!isEating) {
        snake.health -= 1;
        
        // Check if snake starved
        if (snake.health <= 0) {
          deadSnakeIds.add(snake.id);
        }
      }
      
      // Hazards are instant death in this ruleset — entering a hazard cell
      // kills the snake outright regardless of health. Matches the BoardGraph
      // pathfinding treatment (hazards are impassable, same class as walls).
      if (newBoard.hazards.some(h => h.x === newHead.x && h.y === newHead.y)) {
        snake.health = 0;
        deadSnakeIds.add(snake.id);
      }
    }
    
    // Step 5: Remove dead snakes from the board
    newBoard.snakes = newBoard.snakes.filter(s => !deadSnakeIds.has(s.id));
    
    return {
      board: newBoard,
      deadSnakeIds
    };
  }

  private getNewHead(head: Coord, move: Direction): Coord {
    switch (move) {
      case 'up':
        return { x: head.x, y: head.y + 1 };
      case 'down':
        return { x: head.x, y: head.y - 1 };
      case 'left':
        return { x: head.x - 1, y: head.y };
      case 'right':
        return { x: head.x + 1, y: head.y };
      default:
        return head;
    }
  }

  private isAlive(snake: Snake): boolean {
    return snake.health > 0 && snake.body.length > 0;
  }

  private deepCopyBoard(board: Board): Board {
    return {
      height: board.height,
      width: board.width,
      food: (board.food ?? []).map(f => ({ x: f.x, y: f.y })),
      hazards: (board.hazards ?? []).map(h => ({ x: h.x, y: h.y })),
      fertileTiles: board.fertileTiles ? board.fertileTiles.map(f => ({ x: f.x, y: f.y })) : undefined,
      snakes: (board.snakes ?? []).map(snake => ({
        id: snake.id,
        name: snake.name,
        latency: snake.latency,
        health: snake.health,
        body: (snake.body ?? []).map(b => ({ x: b.x, y: b.y })),
        head: { x: snake.head.x, y: snake.head.y },
        length: snake.length,
        shout: snake.shout,
        squad: snake.squad,
        customizations: { ...(snake.customizations ?? {}) },
        invulnerabilityLevel: snake.invulnerabilityLevel
      }))
    };
  }
}