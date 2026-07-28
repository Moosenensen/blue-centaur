/**
 * Regression tests for the StagedMove record: each snake's next move is bound as
 * one atomic value to its (snakeId, turn), dropped as a whole per-snake each turn,
 * and accepted at commit only when it aligns with the turn being answered. This
 * prevents the multi-snake desync where one snake's /move advances the shared
 * board and clobbers another snake's prior-turn staged move, causing a wrong-turn
 * commit — e.g. a 180° reversal into its own neck.
 */

import { ActiveGameManager, TurnData } from '../server/active-game-manager';
import { GameState, Snake, Coord, Direction } from '../types/battlesnake';

function makeSnake(id: string, head: Coord, length = 3): Snake {
  const body: Coord[] = [];
  for (let i = 0; i < length; i++) {
    body.push({ x: head.x, y: head.y - i });
  }
  return {
    id,
    name: id,
    latency: '0',
    health: 100,
    body,
    head,
    length,
    shout: '',
    squad: '',
    customizations: { color: '#ffffff', head: 'default', tail: 'default' },
  };
}

function makeGameState(gameId: string, turn: number, snakes: Snake[], youId: string): GameState {
  const you = snakes.find((s) => s.id === youId)!;
  return {
    game: { id: gameId, ruleset: { name: 'standard', version: '1', settings: {} }, map: 'standard', timeout: 500, source: 'test' },
    turn,
    board: { width: 11, height: 11, food: [], hazards: [], snakes },
    you,
  };
}

function makeRes(): any {
  return { json: jest.fn(), headersSent: false, writableFinished: false, destroyed: false };
}

// Far-future expiry so the per-snake safety timer never fires during a test
// (fake timers also prevent it, but this keeps the computed timeout sane).
const FUTURE_EXPIRY = () => Date.now() + 1_000_000;

function makeTurnData(gs: GameState, botMove: Direction): TurnData {
  return {
    gameState: gs,
    moveEvaluations: [],
    territoryCells: {},
    safeMoves: ['up', 'down', 'left', 'right'],
    botRecommendation: botMove,
    timestamp: Date.now(),
  };
}

describe('Staged move (snakeId, turn) tagging and per-snake wipe', () => {
  let mgr: ActiveGameManager;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    mgr = ActiveGameManager.getInstance();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    warnSpy.mockRestore();
  });

  // Drives the server side of a /move for one snake (register + pending + bot rec).
  function processMove(gameId: string, snakeId: string, snakes: Snake[], turn: number, botMove: Direction) {
    const gs = makeGameState(gameId, turn, snakes, snakeId);
    const existing = mgr.getGame(gameId);
    if (!existing || !existing.controlledSnakes.has(snakeId)) {
      mgr.registerGame(gs);
    }
    mgr.updateGameState(gameId, snakeId, gs);
    mgr.recordTurnArrival(gameId, Date.now(), 500, FUTURE_EXPIRY());
    const res = makeRes();
    mgr.setPendingMove(gameId, snakeId, res, 500, FUTURE_EXPIRY(), turn);
    mgr.setBotRecommendation(gameId, snakeId, botMove, makeTurnData(gs, botMove));
    return res;
  }

  test('negative: a correctly turn-matched staged move is used unchanged', () => {
    const gameId = 'g-match';
    const snakes = [makeSnake('A', { x: 5, y: 5 }), makeSnake('B', { x: 8, y: 8 })];

    // Turn 0 for both snakes. Leave A's pending unresolved.
    const resA0 = processMove(gameId, 'A', snakes, 0, 'right');
    processMove(gameId, 'B', snakes, 0, 'left');

    const game = mgr.getGame(gameId)!;
    const csA = game.controlledSnakes.get('A')!;
    expect(csA.staged?.move).toBe('right');
    expect(csA.staged?.turn).toBe(0);

    // Turn 1 for A: previous-turn-cleanup commits A's turn-0 pending. Its staged
    // move is tagged turn 0, the pending it answers is turn 0 → match → used.
    processMove(gameId, 'A', snakes, 1, 'left');

    expect(resA0.json).toHaveBeenCalledTimes(1);
    expect(resA0.json.mock.calls[0][0].move).toBe('right');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('wipe: a snake\'s own new turn re-tags its staged move; another snake\'s /move never repopulates it', () => {
    const gameId = 'g-wipe';
    const snakes = [makeSnake('A', { x: 5, y: 5 }), makeSnake('B', { x: 8, y: 8 })];

    processMove(gameId, 'A', snakes, 0, 'right');
    processMove(gameId, 'B', snakes, 0, 'left');

    const game = mgr.getGame(gameId)!;
    const csB = game.controlledSnakes.get('B')!;
    expect(csB.staged?.turn).toBe(0);

    // A advances the shared board to turn 1. With the cross-snake refresh removed,
    // B's staged move must remain tagged for turn 0 (not repopulated for turn 1).
    processMove(gameId, 'A', snakes, 1, 'left');
    expect(csB.staged?.turn).toBe(0);

    // B's own /move for turn 1 wipes then re-derives B's staged move for turn 1.
    processMove(gameId, 'B', snakes, 1, 'up');
    expect(csB.staged?.turn).toBe(1);
    expect(csB.staged?.move).toBe('up');
  });

  test('desync (heuristic): B\'s previous-turn-cleanup commits its untouched turn-(N-1) staged move, never the new turn\'s move', () => {
    const gameId = 'g-desync';
    const snakes = [makeSnake('A', { x: 5, y: 5 }), makeSnake('B', { x: 8, y: 8 })];

    // Turn 0: both staged. Keep B's turn-0 pending unresolved.
    processMove(gameId, 'A', snakes, 0, 'right');
    const resB0 = processMove(gameId, 'B', snakes, 0, 'left');

    const game = mgr.getGame(gameId)!;
    const csB = game.controlledSnakes.get('B')!;
    expect(csB.staged?.move).toBe('left');
    expect(csB.staged?.turn).toBe(0);

    // A's /move for turn 1 advances the shared board while B's turn-0 pending is
    // still unresolved. B must be untouched.
    processMove(gameId, 'A', snakes, 1, 'left');
    expect(csB.staged?.turn).toBe(0);

    // B's /move for turn 1: setPendingMove runs previous-turn-cleanup for B's
    // turn-0 pending BEFORE B's staged move is wiped/re-derived. It must commit
    // the turn-0 staged move ('left'), never a turn-1 move.
    const resB1 = makeRes();
    const gsB1 = makeGameState(gameId, 1, snakes, 'B');
    mgr.updateGameState(gameId, 'B', gsB1);
    mgr.setPendingMove(gameId, 'B', resB1, 500, FUTURE_EXPIRY(), 1);

    expect(resB0.json).toHaveBeenCalledTimes(1);
    expect(resB0.json.mock.calls[0][0].move).toBe('left');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('manual isolation: another snake\'s board-advancing /move never reverts or retags a manual snake; the snake reverts only on its OWN next /move', () => {
    const gameId = 'g-manual-iso';
    const snakes = [makeSnake('A', { x: 5, y: 5 }), makeSnake('B', { x: 8, y: 8 })];

    // Turn 0: A heuristic; B stages a MANUAL move ('left'). Leave B's pending open.
    processMove(gameId, 'A', snakes, 0, 'right');
    const resB0 = processMove(gameId, 'B', snakes, 0, 'right');
    mgr.setUserSelection(gameId, 'B', 'left');

    const game = mgr.getGame(gameId)!;
    const csB = game.controlledSnakes.get('B')!;
    expect(csB.staged?.move).toBe('left');
    expect(csB.intent.kind).toBe('manual');
    expect(csB.staged?.turn).toBe(0);

    // A advances the shared board to turn 1. B must be completely untouched: still
    // manual, same staged move, still tagged turn 0 (no cross-snake revert/retag).
    processMove(gameId, 'A', snakes, 1, 'left');
    expect(csB.intent.kind).toBe('manual');
    expect(csB.staged?.move).toBe('left');
    expect(csB.staged?.turn).toBe(0);

    // B's turn-0 previous-turn-cleanup runs on B's own turn-1 /move. The staged
    // move (turn 0) matches the committed pending (turn 0) → the user's manual
    // 'left' is committed, not a fallback.
    const resB1 = makeRes();
    const gsB1 = makeGameState(gameId, 1, snakes, 'B');
    mgr.updateGameState(gameId, 'B', gsB1);
    mgr.setPendingMove(gameId, 'B', resB1, 500, FUTURE_EXPIRY(), 1);
    expect(resB0.json).toHaveBeenCalledTimes(1);
    expect(resB0.json.mock.calls[0][0].move).toBe('left');
    expect(warnSpy).not.toHaveBeenCalled();

    // Completing B's own turn-1 /move reverts the stale single-turn manual to
    // heuristic and re-derives B's staged move for turn 1.
    mgr.setBotRecommendation(gameId, 'B', 'up', makeTurnData(gsB1, 'up'));
    expect(csB.intent.kind).toBe('heuristic');
    expect(csB.staged?.move).toBe('up');
    expect(csB.staged?.turn).toBe(1);
  });

  test('same-turn manual staged during the bot compute window is re-tagged for the new turn and committed (no fallback)', () => {
    const gameId = 'g-manual-race';
    const snakes = [makeSnake('A', { x: 5, y: 5 }), makeSnake('B', { x: 8, y: 8 })];

    // Register both snakes on turn 0, then advance the shared board to turn 1 via A.
    processMove(gameId, 'A', snakes, 0, 'right');
    processMove(gameId, 'B', snakes, 0, 'left');
    processMove(gameId, 'A', snakes, 1, 'left');

    // B's turn-1 /move: create the pending FIRST, then simulate the user staging a
    // manual move while the bot is still computing (setUserSelection runs before
    // setBotRecommendation). At this point boardStateTurn is already 1.
    const gsB1 = makeGameState(gameId, 1, snakes, 'B');
    mgr.updateGameState(gameId, 'B', gsB1);
    mgr.recordTurnArrival(gameId, Date.now(), 500, FUTURE_EXPIRY());
    const resB1 = makeRes();
    mgr.setPendingMove(gameId, 'B', resB1, 500, FUTURE_EXPIRY(), 1);
    mgr.setUserSelection(gameId, 'B', 'left');

    const game = mgr.getGame(gameId)!;
    const csB = game.controlledSnakes.get('B')!;
    expect(csB.intent.kind).toBe('manual');
    expect(csB.staged?.move).toBe('left');

    // Bot finishes and reports its recommendation. The same-turn manual move must
    // stay authoritative (precedence) AND be re-tagged for turn 1.
    mgr.setBotRecommendation(gameId, 'B', 'up', makeTurnData(gsB1, 'up'));
    expect(csB.intent.kind).toBe('manual');
    expect(csB.staged?.move).toBe('left');
    expect(csB.staged?.turn).toBe(1);

    // Committing this turn must use the manual move, not the bot fallback.
    mgr.commitAllStaged(gameId);
    expect(resB1.json).toHaveBeenCalledTimes(1);
    expect(resB1.json.mock.calls[0][0].move).toBe('left');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('logging + fallback: a stale/absent staged record (turn mismatch) warns and falls back to the bot recommendation', () => {
    const gameId = 'g-mismatch';
    const snakes = [makeSnake('A', { x: 5, y: 5 }), makeSnake('B', { x: 8, y: 8 })];

    // Turn 0: both staged (heuristic). Leave both pendings unresolved.
    processMove(gameId, 'A', snakes, 0, 'right');
    const resB0 = processMove(gameId, 'B', snakes, 0, 'left');

    const game = mgr.getGame(gameId)!;
    const csB = game.controlledSnakes.get('B')!;
    expect(csB.staged?.move).toBe('left');
    expect(csB.staged?.turn).toBe(0);
    expect(csB.pendingMove!.turn).toBe(0);
    expect(csB.pendingMove!.botMove).toBe('left');

    // Simulate a stale staged record for B by rebinding it to a different turn
    // (the whole record is replaced, never a field in place), then force a commit.
    // commitStagedMove must reject the turn-mismatched record (against the
    // committed turn 0) and fall back to the bot move ('left').
    csB.staged = { ...csB.staged!, turn: 99 };
    mgr.commitAllStaged(gameId);

    expect(resB0.json).toHaveBeenCalledTimes(1);
    expect(resB0.json.mock.calls[0][0].move).toBe('left'); // bot-move fallback
    expect(warnSpy).toHaveBeenCalled();
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toMatch(/Staged-move turn mismatch \(commit-all\)/);
  });
});
