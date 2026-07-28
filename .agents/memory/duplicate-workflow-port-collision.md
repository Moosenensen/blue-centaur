---
name: Duplicate workflow port collision
description: Flaky 502s / frozen live games can be two workflows both binding port 5000 (EADDRINUSE), not app-code crashes.
---

# Duplicate workflow → port 5000 collision

**Symptom:** intermittent 502 on every route (including `/history`, `/game/:id`),
and a live centaur game "freezing" mid-play (WebSocket silently dies, board stops
updating). Looks like an app crash but the app code is fine.

**Root cause:** more than one workflow configured to run the same server on port
5000. The `Project` run button launches them in `parallel`; each runs `npm run dev`
with `waitForPort = 5000`. The second to bind dies with `EADDRINUSE`, and any
restart race can leave the port held by a dying/zombie process — so the server ends
up down and every request 502s. A live game open at that moment loses its WS and
freezes.

**Why:** two workflows ("Battlesnake Server" and "Start application") both ran
`npm run dev`. Restarting one while the other (or a leftover instance) held 5000
produced `EADDRINUSE` and a down server.

**How to apply / fix:**
- Keep exactly ONE workflow bound to port 5000. `removeWorkflow({name})` the extra
  one, then restart the survivor. Confirm the fresh log shows the "running on port
  5000" banner and NO `EADDRINUSE`.
- When diagnosing 502s, check `getWorkflowStatus` / the workflow log FIRST — a
  `NOT_STARTED`/`FAILED` workflow or `EADDRINUSE` means the server is simply down,
  not that game-end/suicide/logging logic crashed. Don't chase a phantom code bug.
- Note: `getWorkflowStatus.openPorts` may report the proxy port (80); trust the
  server's own startup log line for the real listen port.
