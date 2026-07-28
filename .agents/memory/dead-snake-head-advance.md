---
name: Never fabricate a dead snake's death cell — use authoritative server data
description: Where a snake died must come from the game server, not inferred; the server currently removes dead snakes immediately.
---

# Dead-snake death markers (shared board renderer)

NEVER infer or fabricate where a snake died. An earlier version advanced the
last-seen head one cell "along its heading" to guess the fatal cell. This is
wrong and was explicitly rejected: a snake can turn on its death turn, so a
straight-line guess lands on an empty, non-fatal cell — inventing confusion.

**Why:** The death position is authoritative game state. Guessing it produces
markers that contradict what actually happened (e.g. a death marker on an empty
cell). When the authoritative data isn't available, STOP and ask / report the
gap — do not synthesize a plausible-looking value.

**What data actually exists (as of this writing):**
- The game server removes a dead snake from `board.snakes` the moment it dies,
  so a disappeared snake's true final resting place is NOT in any per-turn state
  we receive. `getDisappearedSnakes` therefore reports only the snake's real
  last-known head/body (honest), never an advanced cell.
- For OUR snake we have better data: the intended move from the staged/committed
  move (`stagedMove` live, `chosen_move` in history) → intended (shadow) marker;
  and the server-reported final head from the `/end` payload (`you.head`, stored
  in `decision_logs.server_outcome.finalHead`) → actual (solid) marker.
- To show real final resting places for ALL snakes (incl. enemies), the GAME
  SERVER must be changed to keep dead snakes in the state for the turn after they
  die (full body + final head). That is a server-side change the user owns.

**How to apply:** Render dead bodies/markers only from real data. Our snake:
shadow = intended move, solid X = server final head, body = real last-known body
(no shift). When NO authoritative final position is available (enemies always;
our snake if `/end` gave no head), draw the "unknown" marker at the last-known
head: a "?" disc with arrows pointing outward in all four directions
(`drawUnknownDeathMarker`). Dead body style: reuse the live continuous-body shape
via `renderSnakeUnified(..., {ghost:true})`, which replaces the solid fill with
diagonal "\" stripes (opposite slant to the fertile-ground "/" stripes) in the
team color.

**Why the "?" marker (user decision):** the last-known head is real, but the
snake could have died moving in any direction from there — the outward arrows say
"ended somewhere out from here, exact cell unknown." This is honest about the
missing data instead of guessing one cell.
