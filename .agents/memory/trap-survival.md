---
name: Trap / fatal-pocket survival
description: How the bot avoids driving into clearly-fatal dead-end pockets; trapped heuristic + veto invariants.
---

# Fatal-pocket survival

The bot must never step into a cell that is legal this turn but leaves no
survivable space next turn (e.g. onto an opponent's vacating tail that turns out
to be a sealed pocket). Two layers enforce this:

1. **`trapped` heuristic** (BoardEvaluator): 1 = fatal pocket, 0 = fine. Strongly
   negative weight (default -600, below the death penalty so it dominates every
   non-survival heuristic). Wired across HeuristicStats/Weights/WeightedScores,
   constructor default, dead-state (set to 0 — death is already captured by
   `deaths:1`, avoid double-penalizing), calculateWeightedScores,
   calculateTotalScore, decision-engine averageEvaluations, and all surfacing
   layers (game-config, voronoi-strategy extractWeights + breakdown log,
   decision-logger type, config.html UI/configKeys/range, board-renderer
   weightedSums + metric row).
2. **Candidate-level veto** (DecisionEngine.decide): after scoring, filter out
   candidates whose averaged `trapped >= 0.5` whenever a non-fatal alternative
   exists, THEN pick max score within that pool. This is the hard guarantee — it
   overrides even a high-scoring waypoint sitting inside the pocket. If every
   candidate is fatal, fall back to scoring all of them (least-bad death).

**Why both:** the weight handles cases where a veto can't apply; the veto is the
absolute guarantee. Don't collapse them into one.

## Survival-aware reachable region (the over-count fix)

`computeReachableRegion` floods from the head via the shared BoardGraph
`snakePassability` predicate and returns `{reachableCount, tailReachable,
parityBound}`. **parityBound = 2*min(white,black)+1** is a checkerboard upper
bound on the longest *simple* path (a snake alternates cell colors each step).

**Why parity:** raw reachable-count over-counts a wide-but-unwalkable blob (e.g. a
plus/cross shape) as survivable. Using the parity bound stops a dead-end from
flipping to survivable.

### `trapped` uses BOTH an upper AND a lower bound (the key insight)

`optimisticRoom = min(reachableCount, parityBound)` is an **UPPER** bound on the
longest simple path — it says a path *could* be that long, NOT that one *exists*.
Relying on `optimisticRoom >= L` alone (the old logic) over-counts a dead-end
pocket you fit into but can't escape ("no return journey" — an articulation point
splits the reachable area so no single simple path uses all of it). Fix: confirm
with a **constructive LOWER bound**.

Current `trapped` logic (optimistic clearance):
1. `tailReachable` → 0 (tail-chase survives forever).
2. else `optimisticRoom < L` → 1 (upper bound already rules out an escape; cheap).
3. else run `greedyLongestWalk` (Warnsdorff-ordered greedy DFS: step to the
   passable-unvisited neighbour with the FEWEST onward free neighbours, no
   backtracking, O(V), capped at L). Not trapped iff the walk actually reaches L
   moves or stumbles onto the tail. The walk builds a real path, so its length is
   a guaranteed lower bound on survivable moves.

**Why:** upper bound catches "obviously too small" cheaply; the greedy walk catches
the deceptive "fits by area but no walkable path" pocket. Warnsdorff is near-optimal
on grids, so false-positive traps are rare. Kept conservative on purpose: the
generous flood's `tailReachable`/parity short-circuits still win (trapped=0), so the
walk only ADDS traps in the narrow "not tail-reachable AND area>=L" window — it
never vetoes a move the old logic allowed via tail-chase.

**Modeling gotcha (why this branch is rarely hit, and hard to unit-test):** under
`optimistic` clearance the time-expanding flood lets enemy/other bodies RECEDE over
time (a cell blocked at its first arrival turn is reached later via a longer path
once it vacates). So enemy walls dissolve and `tailReachable` usually becomes true —
you cannot build a sealed pocket out of enemy bodies under optimistic clearance.
Only OUR OWN body + board edges are permanent walls, and self-walling a region whose
area >= L needs a large ring (perimeter grows with area), so triggering step 3
through `evaluateBoard` needs a big permanently-sealed articulation chamber that is
impractical to encode compactly. Unit-test `greedyLongestWalk` directly instead
(open board → reaches cap; sealed box → stalls well under L).

## Single source of truth for snake-relative passability

`BoardGraph.snakePassability(subject, allSnakes)` returns precomputed
`headKey/tailKey/ownBody/otherTails` + `passable(coord, arrivalTurn, {optimistic,
blockOtherTails})`. calculateSnakeSpace, computeReachableRegion, and
calculateTightSpaceMetrics all defer to it — do NOT re-derive ownBody/otherTails
sets inline. (Note: a couple of other helpers still build local ownBody sets;
migrate them here if you touch them.)

## tail-vacate-on-eat assumption (pinned)

"Just ate" is detected by **head-on-food** (`snakeJustAte`), NOT a duplicated tail
segment. A just-ate snake grows, so its tail does NOT vacate next turn — its tail
cell stays blocked in BOTH `grow-same-turn` and `grow-next-turn`, in
`isPassable` and `isPassableAtTurn`. Stepping onto a just-ate snake's tail is
always fatal. A normal (not-eating) snake's tail IS passable on arrival turn 1.
