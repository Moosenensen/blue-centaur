---
name: Read-only snake selection (history + play scrub)
description: Shared team-grouped snake list + perspective switching in the two read-only viewers, and why it caches.
---

Both the Game History viewer (`history.html`) and play scrub mode
(`play-game.html`) reuse `BoardRenderer.renderSnakeInfo` with
`{ groupByTeam:true, onSelectSnake }` to render a team-grouped, clickable
snake list, and both support clicking one of our team's snakes on the board to
switch perspective.

**Rule:** switching the inspected snake must NOT re-fetch `/api/logs` per click.
Cache decisions per snake and background-prefetch all teammates on load.
**Why:** the original lag was a full-game network round-trip on every snake
selection; with ~5 controlled snakes the prefetch warms them all so switches
are instant.
**How to apply:** any new read-only per-snake inspection should fetch through
the shared cache + prefetch helpers, not call `/api/logs` inline on click.

**`selectableSnakeIds` option on renderSnakeInfo:** decouples "our team" /
which rows are selectable from the active perspective snake (`ourSnakeId`).
Needed for live play where nothing is selected yet (ourSnakeId is null) — pass
`controlledSnakeIds` so the team is still identifiable and selectable.

**Rule:** in any HISTORICAL view, selectability must be keyed on the historical
fact "has logged decisions in this game" (per-game snake list from
`/api/logs/games`), never on the live `controlledSnakeIds` set alone.
**Why:** the live set drops a snake the instant it dies (server deletes it from
`controlledSnakes` on `/end`, and reconnects rebuild the set from live state),
which made since-dead teammates unclickable while scrubbing back to turns where
they were alive and fully logged.
**How to apply:** union the lazily-fetched logged-snake set with the live set
for history-mode gating (panel list, board clicks, prefetch); keep live control
gated on `controlledSnakeIds` alone.
