---
name: Historic decision cache thrash
description: Why snake-selection in the /game viewer felt slow, and the invariant that keeps it instant.
---

# Historic decision cache must not be nuked on live ticks

Per-snake `/api/logs` payloads are large (~1-2MB each: full game_state + move_evaluations incl. territoryCells). The client caches them for the history/scrub viewer. Through the Replit mTLS preview proxy a single 2MB fetch is far slower than a localhost curl, and the browser's 6-connection-per-host limit means a re-fetch of the whole team (5×2MB) plus a duplicate prefetch storm stacks up to multi-second lag on a single snake click.

**Invariant:** logged decisions are immutable except for the growing tail. Never clear the whole cache when a new live turn arrives, and never spawn a duplicate fetch for a snake already in flight.

**How to apply:**
- Reuse a cached snake entry unless the caller needs a turn beyond its cached `maxTurn` **and** more turns have since been logged (`!finishedMode && targetTurn > entry.maxTurn && entry.maxTurn < liveMaxTurn`). Finished games never refetch.
- A DEAD snake's log never grows either: mark its cache entry `complete` (snake absent from the live board past its last logged turn) or the "growing tail" condition stays true forever and every scrub tick past its death re-fetches the 2MB log.
- Board state while scrubbing must be resolvable from ANY cached team log (best row ≤ target turn across caches), never only the inspected snake's — otherwise a dead inspected snake freezes the board at its death turn.
- Coalesce on-demand loads and background prefetch through ONE in-flight promise map (`historicInflight`) so a click rides an existing prefetch instead of starting a second 2MB request.
- Live-turn handlers should only grow `liveMaxTurn` (for slider range); they must NOT invalidate cached old turns.

**Why:** the old code set a `historicCacheStale` flag on every live tick while scrubbing, which cleared ALL snakes' caches and re-fired a 5×2MB prefetch on the next click — the "3 seconds to select a snake" bug.

# /end payload has no `board`

The custom engine's POST `/end` body is `{game,turn,scores,winners,you}` — no `board`. If that final state is stored as `boardState`, any code reading `boardState.board.snakes` throws `Cannot read properties of undefined (reading 'snakes')` on the game-end broadcast path (staged-move fatal hint, snake-ended survivor calc). Always guard `.board?.snakes`.
