---
name: UI sync lockstep + manual testing policy
description: Backend data/heuristic changes must be wired through all UI surfaces in lockstep; UI validation is manual via the user.
---

# Backend↔frontend changes must land in lockstep

Any change to bot data structures (heuristics, field names, breakdown shapes) must be reflected across ALL synchronized surfaces in the same change: core logic (board-evaluator, decision-engine, voronoi-strategy), decision-logger types, config UI, and the history/game viewer (board-renderer.js). The full surface-by-surface checklist lives in [combat-invulnerability-precedence.md](combat-invulnerability-precedence.md) ("Adding any new scoring heuristic") and [clearance-model.md](clearance-model.md) ("How to apply").

**Why:** repeated failures where the config UI had a heuristic the history viewer didn't, weighted totals stopped adding up, or the frontend read old field names while the backend wrote new ones.

**How to apply:**
- Field renames: update TypeScript interfaces everywhere, DB logging, and frontend readers; keep a `?? "—"` fallback so older logged rows still render.
- A change isn't complete until it works in the user-facing viewer, not just logs/API responses. Test end-to-end with real game data from the database.

# UI validation is manual, via the user

Automated browser testing (the Replit run_test tool) has been unreliable in this project — do not depend on it. For any UI-affecting change to the game/history viewer, ask the user for manual verification (screenshots of the viewer with a recent game loaded: decision breakdown, new fields displayed, weighted scores/totals correct) before declaring success.
