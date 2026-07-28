---
name: decision-log turn offset
description: decision_logs.turn is +1 vs game_state.turn / live board turn numbering
---

The `decision_logs.turn` column (returned by `/api/logs` as each decision's
`turn`) is offset by **+1** from the turn the board actually represents. Each
logged decision's `game_state.turn` is the real (live) turn number; the row's
`turn` is `game_state.turn + 1`.

**Why:** the logger records the turn the chosen move *executes into*, not the
turn it evaluated. The Game History viewer happens to display the row `turn`
field, so its header reads one higher than the rendered board's `game_state.turn`
— a pre-existing cosmetic quirk in that page.

**How to apply:** anywhere you align live turn numbering (WebSocket
`board-update` / `currentGameState.turn`, the "Turn:" header) with logged
decisions, key off `decision.game_state.turn`, NOT `decision.turn`. Using the
raw `turn` column gives an off-by-one. The centaur play turn-scrubber builds its
turn→decision map from `game_state.turn` for exactly this reason.
