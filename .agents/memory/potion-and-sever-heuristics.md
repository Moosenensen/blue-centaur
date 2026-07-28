---
name: Potion seeking + sever/kill heuristics
description: The two invulnerability-driven heuristics — drink every potion, and cut out-invulnerated enemies as close to the head as the 3-turn window allows.
---

# Potion seeking + sever/kill heuristics

Two scoring heuristics built on the invulnerability rules. Both live in
`board-evaluator.ts` and are wired through every synchronized surface listed in
[Combat invulnerability precedence](combat-invulnerability-precedence.md).

## The rules they encode

- Drinking an invulnerability potion grants `INVULNERABILITY_DURATION_TURNS` (3)
  turns of invulnerability, counting the turn it is drunk — so **2 further moves**
  can still be spent under it. Poison is the mirror image: the snake that takes it
  is *vulnerable* (negative level) for the same span.
- Moving onto the body of a snake with a **strictly lower** invulnerability level
  severs it at the intersection: the victim keeps head→cut and loses everything
  behind. Cutting at body index `i` of an `L`-long snake removes `L - i` segments,
  so **cutting near the head is worth far more than clipping the tail**, and
  cutting at index 0 is an outright kill.
- `INVULNERABILITY_DURATION_TURNS` lives in `config/game-config.ts` and is the
  fallback/cap used whenever the server omits `invulnerabilityExpiryTurn`.

## `potionSeeking` — stat [0,3], default weight 120

`approach [0,2] + control [0,1]`:

- **approach**: flat `+2` when our head is on a potion (drinking it now — the same
  "eating dominates proximity" shape as `foodEaten`), else
  `(boardSize - pathDistance)/boardSize` to the nearest potion. **Path** distance
  via our own optimistic passability, not Manhattan, so a potion behind a body
  wall doesn't pull us into it.
- **control**: potions inside the Voronoi cells we win (`wonCells`, already computed
  for the contest-aware survival region), normalised by `POTION_CONTROL_SATURATION`
  (3). This is the term that turns "grab the nearest potion" into "collect as many
  as possible" — a position owning a cluster outranks one owning a single potion.

Max contribution +360, under the -500 death penalty (never die for a potion) but
far above `foodProximity` (+50), so potions outrank ordinary food attraction.

## `severKill` — stat [0,2], default weight 200

Fires exactly when we **strictly** out-invulnerate an enemy — we drank a potion, or
they took poison — using expiry-aware levels (`effectiveInvulnerability`), the same
strict rule as `BoardGraph.passabilityFor` severability and the simulator. Allies
are never targeted.

- already standing on a target segment (cut landed): `1 + severedFraction` → (1,2]
- reachable in `d ∈ [1,window]` moves: `severedFraction × (window - d + 1)/(window + 1)` → (0,1]
- unreachable inside the window: 0

`window` = further moves our advantage still has to run (`severabilityWindow`): the
longer of *our* raised level and *their* depressed level, capped at
`INVULNERABILITY_DURATION_TURNS - 1`. A cut we can't land before the potion wears
off is worth zero, so the snake doesn't chase kills it will never reach. The
lookahead flood is therefore ≤2 levels deep — negligible cost.

**Not the same as `aggression`**, which both still run: `aggression` is a plain
closeness pull toward any weaker enemy, `severKill` values the *depth of the cut*
and refuses cuts outside the invulnerability window.

## Gotchas

- `Simulator.deepCopyBoard` used to drop `board.invulnerabilityPotions` and
  `snake.invulnerabilityExpiryTurn`. Both are now carried through — without them
  every simulated state had zero potions and silently fell back to "invulnerable
  this turn only", which zeroes both heuristics in exactly the states that decide
  the move.
- The simulator deliberately does **not** remove a drunk potion or model the
  severed body. Leaving the potion under the new head is precisely how the
  evaluator detects "this move drinks it" (the `onFoodNow` analogue), and leaving
  the victim's body intact is how it detects "this move landed the cut".
