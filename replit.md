# Team Snek Bot - Battlesnake AI

## ⛔ CRITICAL — NEVER DESTROY DATA SILENTLY

**Absolute rule; overrides convenience, deadlines, or "just the dev DB". When in doubt, STOP and ask.**

- **NEVER** run an operation that loses information (`DELETE`/`TRUNCATE`/`DROP`, drop-and-recreate migrations, overwriting data files) without the user's explicit, informed consent.
- **A schema mismatch is NOT a license to wipe rows.** Use data-preserving migrations: `RENAME COLUMN`, or add nullable → backfill → set `NOT NULL`.
- **If blocked without a data-preserving path, PAUSE** and ask the user with options and tradeoffs before doing anything irreversible.

## Overview

Team Snek Bot is a TypeScript-based Battlesnake AI that implements a sophisticated team-based strategy using Voronoi territory analysis. The bot is designed to compete in a **custom Battlesnake engine that allows both human players and AI bots to compete in the same game** - a unique testing environment where humans can directly challenge and analyze bot behavior. The bot uses team-based coordination (when teams are present) and focuses on maximizing controlled territory through Voronoi diagrams while avoiding fatal collisions, particularly head-to-head encounters with larger snakes.

## Game Variant Rules

This bot is specifically designed to play a team-based Battlesnake variant with the following unique rules:

**Team Snek Scoring System:**
- **All snakes are equivalent** — no privileged snake exists. Every snake on a team counts.
- **Control (Centaur):** any snake can be driven by a human or the bot in the same game, so strategy applies per-snake, not to one privileged snake.
- **Scoring:** a team's final score is the **sum of the lengths of that team's snakes still alive at game end**. Dead snakes contribute nothing.
- **Game end:** at the **turn limit declared by the server in the game settings**; if no turn limit is declared, the game ends when **only one team remains**.

**Strategic Implications:**
- **Survival matters**: A dead snake scores zero, so keeping every controllable snake alive protects the team's score.
- **Conservative play**: Avoid risky confrontations, especially head-to-head collisions with larger snakes.
- **Maximize food collection**: Since score = summed length, collecting food directly increases the team's score.
- **Territory control**: Controlling food-rich territory is essential for sustained growth across all of a team's snakes.
- **Food proximity vs. consumption**: The bot distinguishes between:
  - Being near food (proximity) - important for positioning
  - Actually eating food - directly increases score and should be highly rewarded

## User Preferences

- Preferred communication style: Simple, everyday language.
- **Technical Debt Policy**: Prioritize minimizing technical debt over backwards compatibility. Clean, maintainable code is more important than supporting deprecated features since there are no external users.

## System Architecture

### Backend
- **Express + TypeScript + Node.js** — REST API serving the Battlesnake protocol endpoints (`/`, `/start`, `/move`) plus the web UI, with a WebSocket server (`ws`, path `/ws`) attached to the same HTTP server for centaur play.
- **Async decision logging** — non-blocking queued logging to PostgreSQL keeps `/move` responses fast (typically well under the 500ms limit); bounded queue, batching, retries with backoff, graceful-shutdown flush.

### Core Game Logic
- **`BoardGraph`** — single source of truth for passability (walls, snake bodies, hazards, tail-growth timing); all collision checks defer to it. Supports tiered clearance (static / conservative / optimistic) based on when body segments will vacate.
- **`MultiSourceBFS`** — single-pass Voronoi territory computation with tie-awareness.
- **`MoveAnalyzer`** — single source of truth for move enumeration ({safe, risky} sets).
- **`BoardEvaluator`** — unified scoring (territory, food control, space/survival heuristics, hard `trapped` veto for fatal pockets).
- **`DecisionEngine`** — orchestrates enumeration → candidate selection → simulation → evaluation → aggregation → decision, time-bounded to respect the response deadline.
- **`VoronoiStrategy`** — swappable main strategy using the components above.
- **`TeamDetector`** — team identification via squad fields with color-matching fallback; degrades gracefully to individual play.

### Centaur Play Mode
Human-in-the-loop mode: multiple users can view and control snakes in the same live game via RTS-style click-to-select.
- **`/play`** — lobby listing one card per game with its controlled snakes.
- **`/game/:id`** — unified game viewer serving both live games (WebSocket) and finished games (decision-log replay) from the same page.
- Server keeps active game state in an in-memory singleton; unselected snakes run on bot auto-pilot; selections, move staging/commit, and per-turn evaluations flow over per-game WebSocket subscriptions.
- A WebSocket connection debugger logs all connection events (server file + `/connection-debug` viewer) for diagnosing client disconnects.

### Server Activity Page
- **`/activity`** — audit page for autoscale behavior: horizontal bands (green = active with users/game traffic, amber = up but idle, gaps = scaled to zero) with zoom/pan and inspectable event markers. No auto-refresh timers — data loads only on user actions.
- **`server_events` table** records boot, shutdown (written on SIGTERM with a bounded flush), and woke / went-idle transitions (WebSocket connection count 0↔1, plus inbound `/start`/`/move` traffic with a 60s activity window so bot-only games count). Periods with no shutdown event (crash/force-kill) are implicitly closed by the next boot and rendered as "end unknown".

### Database
- **PostgreSQL (Neon)** stores per-move decision logs for analysis and replay.
- **Schema is owned by Drizzle**: `src/database/schema.ts` is the source of truth, there is no startup DDL; dev sync via `npm run db:push`, production via the Publish schema diff.

### Deployment
- Autoscale with max 1 machine (single instance required for WebSocket + in-memory game state).
- Port configurable via `PORT` (default 5000); static web assets served from `src/web`; TypeScript compiled to `dist/` for production; database env vars provided by Replit.
- Public webhook endpoints, no authentication (per Battlesnake protocol).
