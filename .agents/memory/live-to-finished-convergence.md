---
name: Live→finished convergence
description: Centaur play page must converge to the exact static historic replay on gameOver, via the same code path a fresh finished-game load uses.
---

# Live → finished convergence

When a centaur live game ends (server broadcasts `snake-ended` with `gameOver: true`,
then deletes the game from in-memory state), the already-open live page MUST reactively
become the **exact** read-only replay it would be if freshly opened as a finished game —
not a bespoke "game over" live view.

**The rule:** there is ONE convergence path — `enterFinishedMode()`. Both the fresh load
of a finished `/game/:id` (via `game-subscribed` with no boardState) and the reactive
end-of-a-live-game transition call it. `enterFinishedMode()` is idempotent (guards on
`finishedMode`), is log-driven (rebuilds `liveMaxTurn`, perspective = `default_snake_id`
from `/api/logs/games`), and strips live-only chrome via `hideLiveOnlyChrome()`.

**Why:** Users reported a finished game staying stuck on "● LIVE", turn 100/100,
history un-scrubbable. The live handler was rendering the final state + a game-over
banner but never switching `viewMode` out of `'live'`, so it diverged from the static
replay. Do NOT build a second end-of-game rendering path; that guarantees drift.

**How to apply:**
- The last logged turn (not the `/end` final turn) is the historic edge — a live game's
  `/end` payload can be a turn or two past the last logged `/move`. The static replay only
  knows logged turns, so converging on the logged edge is correct/consistent, not a bug.
- `hideLiveOnlyChrome()` is the single list of things that must vanish in finished mode
  (submit/suicide/release buttons, timer, ping, game-over banner, kbd legend, connected
  users). Add any new live-only affordance there so both entry paths hide it.
- The game-over banner is live-only: a fresh static load never shows it, so finished mode
  must hide it too.

**Game-over detection depends on the engine calling POST /end.** The whole live→finished
transition is driven by the server receiving `/end`, running `endGame`, computing
`gameOver` (all controlled snakes removed), and broadcasting `snake-ended`. This is a
CUSTOM Battlesnake engine, so before assuming a client bug when a live game "won't exit
live mode", confirm via logs that `/end` is actually being called and with what shape
(look for `[/end] RECEIVED` and `[WS] broadcasting snake-ended … gameOver=…`). If the
engine never calls `/end`, no `gameOver` ever fires — that's an engine/contract issue,
not a UI bug.

**A finished game must be loadable WITHOUT a live WebSocket.** `/game/:id` also checks
`GET /api/play/game/:id` (404 ⇒ not live ⇒ enterFinishedMode) on a WS-open timeout, so a
dead/blocked socket (or a server that was down) shows the replay or a clear error instead
of hanging forever on "Connecting… / Waiting for game data".
