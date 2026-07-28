---
name: Snake IDs contain '#', must be URL-encoded
description: Logged snake IDs include a '#suffix'; using them raw in query strings silently breaks requests.
---

Battlesnake snake IDs for centaur-controlled snakes look like `BASEID#mepf2x`
(a base id plus a `#`-delimited suffix per controlled snake). The base snake
(no per-snake suffix) has no `#`.

**The trap:** putting such an id raw into a URL query string
(`?snake_id=BASEID#mepf2x`) makes the browser treat `#mepf2x` as the URL
*fragment*, so the server only receives `BASEID`. The request appears to succeed
(it loads the base snake's logs) but silently loads the WRONG snake.

**Rule:** always `encodeURIComponent(snakeId)` (and game ids) when building any
URL that carries a snake id. This bit the history viewer when the default
perspective changed from the base snake to the longest/primary member (which has
a `#` suffix).

**How to apply:** any new fetch/link in the history or play UI that includes a
snake id in the path or query must encode it.

## Related: teamID lives on board.snakes, not `you`

The game-server team name (`teamID`, e.g. `"team_red"`) is carried on the
`board.snakes[]` entries of a logged game_state, NOT on the `game_state.you`
object. To read a snake's team name from a log, look it up in board.snakes by id
(`SELECT s->>'teamID' FROM jsonb_array_elements(game_state->'board'->'snakes') s
WHERE s->>'id' = snake_id`), not `game_state->'you'->>'teamID'` (which is null).
teamID can be a friendly name (`team_red`) or an auto-generated numeric id
(`team_1781...`). Grouping/identity still uses the squad→color→id rule
(TeamDetector.getTeamKey) for in-game consistency; teamID is only for display.
