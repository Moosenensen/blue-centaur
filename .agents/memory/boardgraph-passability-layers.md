---
name: BoardGraph passability layers
description: How BoardGraph separates subject-agnostic physical passability from per-snake subjective passability, and where severability/invuln-expiry live.
---

# BoardGraph passability layers

BoardGraph has **no `you`**. Every perspective-dependent query takes a subject snake id. Two distinct layers:

- **Physical (subject-agnostic):** `isPassable`, `isPassableAtTurn`, adjacency, `getNeighbors(Optimistic)`. Walls + hazards + body segments with tail-vacate timing. NO severability. This is what the shared Voronoi/MultiSourceBFS territory pass walks.
- **Subjective (per-snake):** `passabilityFor(subjectId, opts)` → `{ headKey, tailKey, passable(coord, arrivalTurn) }` (+ thin `isPassableForSnake` wrapper). The single source of truth for "where can THIS snake walk". Layers own-head=origin (never a destination), own-interior=wall, own-tail=vacate-rule, and **invulnerability severability** on top of the physical layer.

**Severability rule:** a subject may pass through another snake's body iff it **strictly** out-invulnerates the owner *at the arrival turn* (`invulnAt(owner) < invulnAt(subject)`). Strict — equal invuln never grants passage. Severability is inherently relative to the mover, so it lives ONLY in the subjective layer.

**Invuln expiry:** `invulnAt(id, absoluteTurn)` returns the level only while `absoluteTurn <= meta.expiryTurn`, else 0. `expiryTurn` is read straight from the server-provided `Snake.invulnerabilityExpiryTurn`; when absent it falls back to the current turn (level applies this turn only). **Do NOT compute expiry ourselves** — defer to the server property. +1 invuln is team-conferred and can lapse early, so subject-side caution matters.

**Tail handling option:** `opts.opponentTailsAlwaysImpassable` force-blocks enemy (non-teammate) tails instead of assuming they vacate. Survival/space heuristics (computeReachableRegion, calculateTightSpaceMetrics) set it true; waypoint routing and the move-legality gate use the default (assume vacate). This replaced the old `snakePassability(...).passable(..., {blockOtherTails})` (old `blockOtherTails:true` ≡ new `opponentTailsAlwaysImpassable:true`).

**Why two layers:** consolidating ALL snake-subjective passability into one query-efficient method removed duplicated inline floodfill rules and the old bug where every snake's food-reach used OUR severability. `calculateSnakeFoodReachability` now delegates to `passabilityFor(id,{optimistic:false})` per snake.

**Known accepted tradeoff:** the shared Voronoi territory BFS (physical layer) no longer applies severability — a severable weaker enemy is treated as a wall for territory, slightly more conservative. Deferred/accepted.

**Build order:** two-phase. Phase 1 builds segments + static blocked set + adjacency (so `passabilityFor({optimistic:false})` works). Phase 2 runs food-reach over the static predicate, then fills each segment's `conservativeDisappearTurn` (which the optimistic layer needs). Breaking this order reintroduces a circular dependency.
