---
name: Fatal-move consent + neck-reversal guards
description: Consent gate for human certain-death moves and the adjacency-is-not-validity lesson behind 180° reversals.
---

**Rule 1 — consent gate:** A human-sourced staged move that is certain death (manual/queue/waypoint) may only stage with a branded `FatalMoveConsent`, mintable solely in `confirmFatalMove` (server re-validates fatality + controlling user) and the kill-all suicide paths. Unconsented → fall back to bot move + one-per-turn WS confirmation prompt. Bot-sourced fatal moves are exempt; commit stays a pure passthrough (no re-checks at commit time).
**Why:** silent fatal submissions killed snakes without user intent; a branded type makes it a compile-time impossibility to bypass the dialog.

**Rule 2 — adjacency ≠ validity:** Never derive a move from a plan cell just because it's adjacent to the head. The just-vacated neck (body[1]) is always adjacent and always a 180° death. Queue/waypoint derivation must reject the neck cell, and queue-advance HOLD tolerance must clear (not hold) a plan cell equal to the current live head — holding it produces a perfect reversal next turn.
**Why:** this exact HOLD-retention pattern caused a real in-game death (queue cell became the neck one turn later).

**Tripwire:** a permanent warn logs full state whenever any staged move steps onto the snake's own neck. Tests staging arbitrary moves must avoid genuine reversals or they'll trip it.

**How to apply:** any new move source (new intent mode, automation) must route through the same consent gate and neck guards; never add a second minting site for the consent brand.
