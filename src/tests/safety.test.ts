/**
 * Tests for safety heuristics: edge penalty
 */

import { BoardEvaluator } from '../logic/board-evaluator';
import { GameState, Snake } from '../types/battlesnake';

describe('Safety Heuristics Tests', () => {
  
  test('Edge penalty should penalize snakes on board edges', () => {
    const evaluator = new BoardEvaluator();
    
    // Snake on edge (x=0)
    const edgeState: GameState = {
      game: { id: 'test', ruleset: { name: 'standard', version: '1', settings: {} }, timeout: 500, source: 'test', map: 'standard' },
      turn: 1,
      board: {
        width: 11,
        height: 11,
        snakes: [{
          id: 'snake1',
          name: 'Edge Snake',
          health: 100,
          body: [
            {x: 0, y: 5},  // Head on left edge
            {x: 1, y: 5},
            {x: 2, y: 5}
          ],
          head: {x: 0, y: 5},
          length: 3,
          latency: '100',
          shout: '',
          squad: '',
          customizations: {color: '#FF0000', head: 'default', tail: 'default'}
        }],
        food: [],
        hazards: []
      },
      you: {} as Snake  // Will be set by evaluator
    };
    
    const evaluation = evaluator.evaluateBoard(edgeState, 'snake1', new Set(['snake1']));
    console.log('Edge penalty for edge snake:', evaluation.stats.edgePenalty);
    console.log('Weighted edge penalty score:', evaluation.weighted.edgePenaltyScore);
    
    // Should have edge penalty of -1
    expect(evaluation.stats.edgePenalty).toBe(-1);
    // With weight of 50, should contribute -50 to the score
    expect(evaluation.weighted.edgePenaltyScore).toBe(-50);
    
    // Snake in middle of board
    const middleState: GameState = {
      ...edgeState,
      board: {
        ...edgeState.board,
        snakes: [{
          ...edgeState.board.snakes[0],
          body: [
            {x: 5, y: 5},  // Head in middle
            {x: 4, y: 5},
            {x: 3, y: 5}
          ],
          head: {x: 5, y: 5}
        }]
      }
    };
    
    const middleEval = evaluator.evaluateBoard(middleState, 'snake1', new Set(['snake1']));
    console.log('Edge penalty for middle snake:', middleEval.stats.edgePenalty);
    
    // Should have no edge penalty
    expect(middleEval.stats.edgePenalty).toBe(0);
    expect(middleEval.weighted.edgePenaltyScore).toBe(0);
  });
});
