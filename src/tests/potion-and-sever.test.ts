/**
 * Tests for the two offensive/greedy heuristics:
 *  - potionSeeking: drink as many invulnerability potions as possible
 *  - severKill: cut enemies we out-invulnerate, as close to their head as possible
 */

import { BoardEvaluator } from '../logic/board-evaluator';
import { Coord, GameState, Snake } from '../types/battlesnake';

interface SnakeSpec {
  id: string;
  body: Coord[];
  color?: string;
  invulnerabilityLevel?: number;
  invulnerabilityExpiryTurn?: number;
}

function makeSnake(spec: SnakeSpec): Snake {
  return {
    id: spec.id,
    name: spec.id,
    health: 100,
    body: spec.body,
    head: spec.body[0],
    length: spec.body.length,
    latency: '0',
    shout: '',
    squad: '',
    customizations: { color: spec.color ?? '#FF0000', head: 'default', tail: 'default' },
    invulnerabilityLevel: spec.invulnerabilityLevel,
    invulnerabilityExpiryTurn: spec.invulnerabilityExpiryTurn
  };
}

function makeState(opts: {
  snakes: SnakeSpec[];
  potions?: Coord[];
  food?: Coord[];
  hazards?: Coord[];
  turn?: number;
}): GameState {
  const snakes = opts.snakes.map(makeSnake);
  return {
    game: {
      id: 'test',
      ruleset: { name: 'standard', version: '1', settings: {} },
      timeout: 500,
      source: 'test',
      map: 'standard'
    },
    turn: opts.turn ?? 10,
    board: {
      width: 11,
      height: 11,
      snakes,
      food: opts.food ?? [],
      hazards: opts.hazards ?? [],
      invulnerabilityPotions: opts.potions
    },
    you: snakes[0]
  };
}

// Our snake sits in open space in the middle-left of the board.
const OUR_BODY: Coord[] = [{ x: 5, y: 5 }, { x: 5, y: 4 }, { x: 5, y: 3 }];

function potionStat(state: GameState): number {
  const evaluator = new BoardEvaluator();
  return evaluator.evaluateBoard(state, 'us', new Set(['us'])).stats.potionSeeking;
}

function severStat(state: GameState): number {
  const evaluator = new BoardEvaluator();
  return evaluator.evaluateBoard(state, 'us', new Set(['us'])).stats.severKill;
}

describe('potionSeeking heuristic', () => {
  it('is 0 when the board has no potions', () => {
    const state = makeState({ snakes: [{ id: 'us', body: OUR_BODY }] });
    expect(potionStat(state)).toBe(0);
  });

  it('rewards being closer to a potion', () => {
    const near = makeState({
      snakes: [{ id: 'us', body: OUR_BODY }],
      potions: [{ x: 6, y: 5 }]
    });
    const far = makeState({
      snakes: [{ id: 'us', body: OUR_BODY }],
      potions: [{ x: 10, y: 10 }]
    });
    expect(potionStat(near)).toBeGreaterThan(potionStat(far));
  });

  it('gives the flat drink bonus when our head is on the potion', () => {
    const drinking = makeState({
      snakes: [{ id: 'us', body: OUR_BODY }],
      potions: [{ x: 5, y: 5 }]
    });
    const adjacent = makeState({
      snakes: [{ id: 'us', body: OUR_BODY }],
      potions: [{ x: 6, y: 5 }]
    });
    // Drinking scores the full +2 approach term; the control term adds the same
    // amount in both states (one owned potion), so drinking must score higher.
    expect(potionStat(drinking)).toBeGreaterThanOrEqual(2);
    expect(potionStat(drinking)).toBeGreaterThan(potionStat(adjacent));
  });

  it('prefers owning several potions over owning one', () => {
    const cluster = makeState({
      snakes: [{ id: 'us', body: OUR_BODY }],
      potions: [{ x: 6, y: 5 }, { x: 6, y: 6 }, { x: 7, y: 5 }]
    });
    const single = makeState({
      snakes: [{ id: 'us', body: OUR_BODY }],
      potions: [{ x: 6, y: 5 }]
    });
    // Same nearest-potion distance in both, so the difference is purely the
    // control term: more potions inside our territory scores higher.
    expect(potionStat(cluster)).toBeGreaterThan(potionStat(single));
    expect(potionStat(cluster)).toBeLessThanOrEqual(3);
  });

  it('ignores a potion we cannot reach at all', () => {
    // Potion sits in a corner sealed off by hazards, which never recede.
    const walled = makeState({
      snakes: [{ id: 'us', body: OUR_BODY }],
      potions: [{ x: 0, y: 0 }],
      hazards: [{ x: 0, y: 1 }, { x: 1, y: 0 }]
    });
    // Unreachable => no approach term, and the sealed cell is nobody's
    // territory => no control term either.
    expect(potionStat(walled)).toBe(0);
  });
});

describe('severKill heuristic', () => {
  const enemyId = 'them';

  it('does not fire against an equally-invulnerable enemy', () => {
    const state = makeState({
      snakes: [
        { id: 'us', body: OUR_BODY },
        { id: enemyId, color: '#00FF00', body: [{ x: 7, y: 5 }, { x: 8, y: 5 }, { x: 9, y: 5 }, { x: 10, y: 5 }] }
      ]
    });
    expect(severStat(state)).toBe(0);
  });

  it('fires when we are invulnerable and the enemy is not', () => {
    const state = makeState({
      snakes: [
        { id: 'us', body: OUR_BODY, invulnerabilityLevel: 1 },
        { id: enemyId, color: '#00FF00', body: [{ x: 7, y: 5 }, { x: 8, y: 5 }, { x: 9, y: 5 }, { x: 10, y: 5 }] }
      ]
    });
    expect(severStat(state)).toBeGreaterThan(0);
  });

  it('fires when the enemy is vulnerable even though we are not invulnerable', () => {
    const state = makeState({
      snakes: [
        { id: 'us', body: OUR_BODY },
        {
          id: enemyId,
          color: '#00FF00',
          invulnerabilityLevel: -1,
          body: [{ x: 7, y: 5 }, { x: 8, y: 5 }, { x: 9, y: 5 }, { x: 10, y: 5 }]
        }
      ]
    });
    expect(severStat(state)).toBeGreaterThan(0);
  });

  it('prefers a cut near the enemy head over the same-distance cut near its tail', () => {
    // Identical geometry; only the direction of the enemy body differs, so the
    // cell we can reach is its head in one case and its tail in the other.
    const headSide = makeState({
      snakes: [
        { id: 'us', body: OUR_BODY, invulnerabilityLevel: 1 },
        { id: enemyId, color: '#00FF00', body: [{ x: 7, y: 5 }, { x: 8, y: 5 }, { x: 9, y: 5 }, { x: 10, y: 5 }] }
      ]
    });
    const tailSide = makeState({
      snakes: [
        { id: 'us', body: OUR_BODY, invulnerabilityLevel: 1 },
        { id: enemyId, color: '#00FF00', body: [{ x: 10, y: 5 }, { x: 9, y: 5 }, { x: 8, y: 5 }, { x: 7, y: 5 }] }
      ]
    });
    expect(severStat(headSide)).toBeGreaterThan(severStat(tailSide));
  });

  it('scores a landed cut above any cut still to be reached', () => {
    // Our head shares a cell with the enemy's second segment: the cut has landed.
    const landed = makeState({
      snakes: [
        {
          id: 'us',
          body: [{ x: 8, y: 5 }, { x: 7, y: 5 }, { x: 6, y: 5 }],
          invulnerabilityLevel: 1
        },
        { id: enemyId, color: '#00FF00', body: [{ x: 8, y: 6 }, { x: 8, y: 5 }, { x: 8, y: 4 }, { x: 8, y: 3 }] }
      ]
    });
    const approaching = makeState({
      snakes: [
        { id: 'us', body: OUR_BODY, invulnerabilityLevel: 1 },
        { id: enemyId, color: '#00FF00', body: [{ x: 7, y: 5 }, { x: 8, y: 5 }, { x: 9, y: 5 }, { x: 10, y: 5 }] }
      ]
    });
    expect(severStat(landed)).toBeGreaterThan(1);
    expect(severStat(landed)).toBeLessThanOrEqual(2);
    expect(severStat(landed)).toBeGreaterThan(severStat(approaching));
  });

  it('ignores cuts we cannot reach before our invulnerability expires', () => {
    // Invulnerable only for this turn: no further move can land a cut.
    const expiring = makeState({
      turn: 10,
      snakes: [
        { id: 'us', body: OUR_BODY, invulnerabilityLevel: 1, invulnerabilityExpiryTurn: 10 },
        { id: enemyId, color: '#00FF00', body: [{ x: 7, y: 5 }, { x: 8, y: 5 }, { x: 9, y: 5 }, { x: 10, y: 5 }] }
      ]
    });
    expect(severStat(expiring)).toBe(0);

    // Same board, one more turn of invulnerability left: the cut is now in range.
    const inRange = makeState({
      turn: 10,
      snakes: [
        { id: 'us', body: OUR_BODY, invulnerabilityLevel: 1, invulnerabilityExpiryTurn: 12 },
        { id: enemyId, color: '#00FF00', body: [{ x: 7, y: 5 }, { x: 8, y: 5 }, { x: 9, y: 5 }, { x: 10, y: 5 }] }
      ]
    });
    expect(severStat(inRange)).toBeGreaterThan(0);
  });

  it('never targets a teammate', () => {
    const state = makeState({
      snakes: [
        { id: 'us', body: OUR_BODY, invulnerabilityLevel: 1 },
        { id: 'ally', body: [{ x: 7, y: 5 }, { x: 8, y: 5 }, { x: 9, y: 5 }, { x: 10, y: 5 }] }
      ]
    });
    const evaluator = new BoardEvaluator();
    const stats = evaluator.evaluateBoard(state, 'us', new Set(['us', 'ally'])).stats;
    expect(stats.severKill).toBe(0);
  });
});
