/**
 * Comprehensive tests for enhanced space detection logic
 */

import { BoardEvaluator } from '../logic/board-evaluator';
import { GameState } from '../types/battlesnake';

describe('Enhanced Space Detection', () => {
  let evaluator: BoardEvaluator;
  
  beforeEach(() => {
    // Create evaluator with specific weights for testing
    evaluator = new BoardEvaluator({
      selfSpace: 20,
      alliesEnoughSpace: 10,
      opponentsEnoughSpace: -15
    });
  });

  describe('Basic Space Detection', () => {
    it('should report plenty (selfSpace > 1) when snake has open room', () => {
      // Snake in open area with lots of space
      const gameState: GameState = {
        game: {
          id: 'test',
          ruleset: { name: 'standard', version: '1', settings: {} },
          timeout: 500,
          source: 'test',
          map: 'standard'
        },
        turn: 10,
        board: {
          width: 11,
          height: 11,
          snakes: [{
            id: 'our-snake',
            name: 'Test Snake',
            health: 100,
            body: [
              { x: 5, y: 5 },
              { x: 5, y: 4 },
              { x: 5, y: 3 }
            ],
            head: { x: 5, y: 5 },
            length: 3,
            latency: '0',
            shout: '',
            squad: '',
            customizations: { color: '#FF0000', head: 'default', tail: 'default' }
          }],
          food: [],
          hazards: []
        },
        you: {
          id: 'our-snake',
          name: 'Test Snake',
          health: 100,
          body: [
            { x: 5, y: 5 },
            { x: 5, y: 4 },
            { x: 5, y: 3 }
          ],
          head: { x: 5, y: 5 },
          length: 3,
          latency: '0',
          shout: '',
          squad: '',
          customizations: { color: '#FF0000', head: 'default', tail: 'default' }
        }
      };

      const result = evaluator.evaluateBoard(gameState, 'our-snake', new Set(['our-snake']));
      
      console.log('Open space test - selfSpace:', result.stats.selfSpace);
      console.log('Open space test - full stats:', result.stats);
      
      // sqrt(room/length): open board room >> length, so plenty scores above 1.0
      expect(result.stats.selfSpace).toBeGreaterThan(1);
    });

    it('should report scarce room (selfSpace < 1) when snake is trapped', () => {
      // Snake truly trapped in a closed loop with no escape
      const gameState: GameState = {
        game: {
          id: 'test',
          ruleset: { name: 'standard', version: '1', settings: {} },
          timeout: 500,
          source: 'test',
          map: 'standard'
        },
        turn: 10,
        board: {
          width: 11,
          height: 11,
          snakes: [{
            id: 'our-snake',
            name: 'Test Snake',
            health: 100,
            body: [
              { x: 1, y: 1 },  // Head trapped inside
              { x: 2, y: 1 },  // Body forms walls
              { x: 2, y: 2 },
              { x: 2, y: 3 },
              { x: 1, y: 3 },
              { x: 0, y: 3 },
              { x: 0, y: 2 },
              { x: 0, y: 1 },
              { x: 0, y: 0 },
              { x: 1, y: 0 },
              { x: 2, y: 0 }   // Tail completes the box
            ],
            head: { x: 1, y: 1 },
            length: 11,
            latency: '0',
            shout: '',
            squad: '',
            customizations: { color: '#FF0000', head: 'default', tail: 'default' }
          }],
          food: [],
          hazards: []
        },
        you: {
          id: 'our-snake',
          name: 'Test Snake',
          health: 100,
          body: [
            { x: 1, y: 1 },
            { x: 2, y: 1 },
            { x: 2, y: 2 },
            { x: 2, y: 3 },
            { x: 1, y: 3 },
            { x: 0, y: 3 },
            { x: 0, y: 2 },
            { x: 0, y: 1 },
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 2, y: 0 }
          ],
          head: { x: 1, y: 1 },
          length: 11,
          latency: '0',
          shout: '',
          squad: '',
          customizations: { color: '#FF0000', head: 'default', tail: 'default' }
        }
      };

      const result = evaluator.evaluateBoard(gameState, 'our-snake', new Set(['our-snake']));
      
      console.log('Trapped snake test - selfSpace:', result.stats.selfSpace);
      console.log('Trapped snake test - full stats:', result.stats);
      
      // Reachable room is far below body length, so sqrt(room/length) stays under 1.0
      expect(result.stats.selfSpace).toBeLessThan(1);
    });
  });

  describe('Opponent Space Detection', () => {
    it('should detect when opponent is trapped', () => {
      // Enemy snake truly trapped in a small area with our snake boxing it in
      const gameState: GameState = {
        game: {
          id: 'test',
          ruleset: { name: 'standard', version: '1', settings: {} },
          timeout: 500,
          source: 'test',
          map: 'standard'
        },
        turn: 10,
        board: {
          width: 11,
          height: 11,
          snakes: [
            {
              id: 'our-snake',
              name: 'Our Snake',
              health: 100,
              body: [
                { x: 3, y: 3 },  // Our head
                { x: 3, y: 2 },  // Our body forming a wall
                { x: 3, y: 1 },
                { x: 3, y: 0 },
                { x: 2, y: 0 },
                { x: 1, y: 0 },
                { x: 0, y: 0 },
                { x: 0, y: 1 },
                { x: 0, y: 2 },
                { x: 0, y: 3 },
                { x: 1, y: 3 },
                { x: 2, y: 3 }   // Our tail completes the box
              ],
              head: { x: 3, y: 3 },
              length: 12,
              latency: '0',
              shout: '',
              squad: '',
              customizations: { color: '#00FF00', head: 'default', tail: 'default' }
            },
            {
              id: 'enemy-snake',
              name: 'Enemy',
              health: 100,
              body: [
                { x: 1, y: 1 },  // Enemy head trapped inside our box
                { x: 2, y: 1 },  // Enemy body
                { x: 2, y: 2 },
                { x: 1, y: 2 }   // Enemy tail
              ],
              head: { x: 1, y: 1 },
              length: 4,
              latency: '0',
              shout: '',
              squad: '',
              customizations: { color: '#FF0000', head: 'default', tail: 'default' }
            }
          ],
          food: [],
          hazards: []
        },
        you: {
          id: 'our-snake',
          name: 'Our Snake',
          health: 100,
          body: [
            { x: 3, y: 3 },
            { x: 3, y: 2 },
            { x: 3, y: 1 },
            { x: 3, y: 0 },
            { x: 2, y: 0 },
            { x: 1, y: 0 },
            { x: 0, y: 0 },
            { x: 0, y: 1 },
            { x: 0, y: 2 },
            { x: 0, y: 3 },
            { x: 1, y: 3 },
            { x: 2, y: 3 }
          ],
          head: { x: 3, y: 3 },
          length: 12,
          latency: '0',
          shout: '',
          squad: '',
          customizations: { color: '#00FF00', head: 'default', tail: 'default' }
        }
      };

      const result = evaluator.evaluateBoard(gameState, 'our-snake', new Set(['our-snake']));
      
      console.log('Enemy trapped test - opponentsEnoughSpace:', result.stats.opponentsEnoughSpace);
      console.log('Enemy trapped test - weighted score:', result.weighted.opponentsEnoughSpaceScore);
      console.log('Enemy trapped test - full stats:', result.stats);
      
      // Enemy should have limited space, likely -3 or close to it
      expect(result.stats.opponentsEnoughSpace).toBeLessThan(3);
      // With weight of -15, a negative opponent score should produce positive weighted score
      expect(result.weighted.opponentsEnoughSpaceScore).not.toBe(0);
    });
  });

  describe('Team Space Detection', () => {
    it('should calculate ally space correctly', () => {
      const gameState: GameState = {
        game: {
          id: 'test',
          ruleset: { name: 'standard', version: '1', settings: {} },
          timeout: 500,
          source: 'test',
          map: 'standard'
        },
        turn: 10,
        board: {
          width: 11,
          height: 11,
          snakes: [
            {
              id: 'our-snake',
              name: 'Our Snake',
              health: 100,
              body: [
                { x: 5, y: 5 },
                { x: 4, y: 5 },
                { x: 3, y: 5 }
              ],
              head: { x: 5, y: 5 },
              length: 3,
              latency: '0',
              shout: '',
              squad: 'team1',
              customizations: { color: '#00FF00', head: 'default', tail: 'default' }
            },
            {
              id: 'ally-snake',
              name: 'Ally',
              health: 100,
              body: [
                { x: 8, y: 8 },
                { x: 8, y: 7 },
                { x: 8, y: 6 }
              ],
              head: { x: 8, y: 8 },
              length: 3,
              latency: '0',
              shout: '',
              squad: 'team1',
              customizations: { color: '#00FF00', head: 'default', tail: 'default' }
            }
          ],
          food: [],
          hazards: []
        },
        you: {
          id: 'our-snake',
          name: 'Our Snake',
          health: 100,
          body: [
            { x: 5, y: 5 },
            { x: 4, y: 5 },
            { x: 3, y: 5 }
          ],
          head: { x: 5, y: 5 },
          length: 3,
          latency: '0',
          shout: '',
          squad: 'team1',
          customizations: { color: '#00FF00', head: 'default', tail: 'default' }
        }
      };

      const result = evaluator.evaluateBoard(gameState, 'our-snake', new Set(['our-snake', 'ally-snake']));
      
      console.log('Ally space test - selfSpace:', result.stats.selfSpace);
      console.log('Ally space test - alliesEnoughSpace:', result.stats.alliesEnoughSpace);
      console.log('Ally space test - weighted ally score:', result.weighted.alliesEnoughSpaceScore);
      console.log('Ally space test - full stats:', result.stats);
      
      // Both snakes have plenty of space
      expect(result.stats.selfSpace).toBeGreaterThan(1);
      expect(result.stats.alliesEnoughSpace).toBeGreaterThanOrEqual(1);
      expect(result.weighted.alliesEnoughSpaceScore).not.toBe(0);
    });
  });

  describe('Weighted Score Calculation', () => {
    it('should apply weights correctly to space scores', () => {
      const gameState: GameState = {
        game: {
          id: 'test',
          ruleset: { name: 'standard', version: '1', settings: {} },
          timeout: 500,
          source: 'test',
          map: 'standard'
        },
        turn: 10,
        board: {
          width: 11,
          height: 11,
          snakes: [
            {
              id: 'our-snake',
              name: 'Our Snake',
              health: 100,
              body: [
                { x: 5, y: 5 },
                { x: 4, y: 5 },
                { x: 3, y: 5 }
              ],
              head: { x: 5, y: 5 },
              length: 3,
              latency: '0',
              shout: '',
              squad: '',
              customizations: { color: '#00FF00', head: 'default', tail: 'default' }
            }
          ],
          food: [],
          hazards: []
        },
        you: {
          id: 'our-snake',
          name: 'Our Snake',
          health: 100,
          body: [
            { x: 5, y: 5 },
            { x: 4, y: 5 },
            { x: 3, y: 5 }
          ],
          head: { x: 5, y: 5 },
          length: 3,
          latency: '0',
          shout: '',
          squad: '',
          customizations: { color: '#00FF00', head: 'default', tail: 'default' }
        }
      };

      const result = evaluator.evaluateBoard(gameState, 'our-snake', new Set(['our-snake']));
      
      console.log('Weight test - selfSpace value:', result.stats.selfSpace);
      console.log('Weight test - selfSpace weight:', result.weights.selfSpace);
      console.log('Weight test - selfSpace weighted score:', result.weighted.selfSpaceScore);
      
      // Verify weight multiplication
      const expectedWeightedScore = result.stats.selfSpace * result.weights.selfSpace;
      expect(result.weighted.selfSpaceScore).toBe(expectedWeightedScore);
      expect(result.weights.selfSpace).toBe(20); // Our configured weight
    });
  });
});