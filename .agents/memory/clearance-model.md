---
name: 3-tier clearance model + contest-aware survival
description: How BoardGraph clearance modes and the contest-aware conservative survival region work, and why.
---

# 3-tier clearance model

`BoardGraph.passabilityFor(id, {clearance})` takes `clearance: 'static' | 'conservative' | 'optimistic'` (replaced the old `optimistic` boolean and the `opponentTailsAlwaysImpassable` flag).

- **static** — nothing recedes; every current body segment blocks. Most pessimistic.
- **conservative** — segments recede by `potentialFoodEaten` timing (food a snake could plausibly reach within lookahead).
- **optimistic** — segments recede by `canEatThisTurn` only. Least pessimistic (segments vacate soonest).

Own interior is ALWAYS treated as a wall regardless of clearance. Severability of enemies is strict and expiry-aware (see boardgraph-passability-layers.md).

**Why survival pessimism is NOT from blocking enemy tails:** conservative is more pessimistic than optimistic purely via food-aware receding timing (`potentialFoodEaten >= canEatThisTurn`), not by forcing enemy tails impassable. The old `opponentTailsAlwaysImpassable` was dropped in favor of this.

**Critical timing constraint — physical vs conservative are DECOUPLED fields.** `fillDisappearTurns` sets TWO separate per-segment turns:
- `physicalDisappearTurn = base + potentialFoodEaten` (NO buffer). This is the true "cell is free" turn used by the subject-agnostic Voronoi physical layer `isPassableAtTurn`. Do NOT add a buffer here — it breaks Voronoi tail-vacate logic and `isPassableAtTurn(tail,1)`.
- `conservativeDisappearTurn = physicalDisappearTurn + 1` (one-turn survival safety buffer). Used ONLY by the pessimistic `conservative` clearance mode (contest-aware survival region + trap veto).

**Why the +1 lives only in conservative:** survival reasoning wants an extra turn of pessimism, but the physical Voronoi layer and candidate move-safety (which use `optimistic` clearance) must reflect real tail timing. Keeping the +1 in a dedicated `conservativeDisappearTurn` field lets survival be pessimistic without corrupting physical passability. An earlier attempt applied +1 directly to a shared field and broke `isPassableAtTurn`/Voronoi — hence the split.

# Contest-aware conservative survival region

`board-evaluator.ts` `computeContestAwareRegion` floods from our head under **conservative** clearance but restricted to cells our snake wins in the Voronoi contest (`wonCells`) plus our own tail cell. This yields a survival estimate that discounts space an opponent would reach first.

**SUPERSEDED (2026-07-01 self-space simplification):** the three-metric design below
(`selfEnoughSpace` + `selfSpaceConservative` + `selfSpaceOptimistic`, tanh saturation,
`spacePlentyMultiplier`) was **collapsed into a single continuous `selfSpace`** plus the
`trapped` veto (user-approved, 2026-07-01). This
supersedes the original task #69 "Done looks like" bullets that asked for three metrics.

Current state:
- `selfSpace` = `sqrt(min(reachableCount, parityBound) / length)` over the contest-aware
  conservative region (`computeContestAwareRegion`). Room == body length → 1.0, 4× → 2.0,
  ¼ → 0.5. Sub-linear but strictly increasing, so a huge open board no longer drowns the
  total. Replaced the tanh saturation (no more `spacePlentyMultiplier`).
- `trapped` = hard 0/1 fatal-pocket veto, computed under **optimistic** clearance. Detail
  and the Warnsdorff greedy-walk lower bound: see trap-survival.md.
- `alliesEnoughSpace` / `opponentsEnoughSpace` = still flat ±1 sums across allied/opponent
  snakes (untouched by the simplification).

**Removed** (folded into `selfSpace` or deleted): `selfEnoughSpace`, `selfSpaceConservative`,
`selfSpaceOptimistic`, `tightSpaceScore`, `tightSpaceThreshold`, `connectivityPenalty`,
`tailReachable` (as a scored heuristic — region still tracks it internally),
`spacePlentyMultiplier`, and the tanh helpers.

**How to apply:** `selfSpace` and `trapped` must stay synced across every surface:
board-evaluator interfaces/defaults/dead-state, decision-engine `averageEvaluations`, the
shared `moveEvaluations` breakdown builder in `voronoi-strategy-new.ts` (feeds BOTH DB
logging via `logDecision` AND `getBestMoveWithDebug` — one object, two consumers), the
console breakdown table, `config.html` slider + configKeys, and `board-renderer.js` (shared
by history.html and play-game.html). Use `?? "—"` fallback for older logs missing the field.

## Per-segment eat accounting (disappear turns)
Rule: an eat at turn t only delays body segments whose vacate turn comes AFTER the eat lands — grow-next-turn: vacate > t; grow-same-turn: vacate >= t. Turn-0 justAte (head on food) delays everything.
**Why:** a uniform "could eat this turn" +1 applied to every segment falsely blocked the tail (which vacates the same turn the eat lands), making the red fatal marker misfire when staging onto a vacating tail near food.
**How to apply:** any future change to fillDisappearTurns or clearance timing must keep the per-segment delay predicate; own interior body stays never-passable to the subject in passabilityFor (test interior timing via the physical isPassableAtTurn layer, not passabilityFor).
