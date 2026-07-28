---
name: move_evaluations JSONB format
description: The decision_logs.move_evaluations blob shape and its legacy-format fallback.
---

# `decision_logs.move_evaluations` shape

Stored as `{evaluations: [...], territoryCells: {snakeId: [{x,y},...]}}`. The `territoryCells` map drives the Voronoi territory overlay in the game viewer.

**Legacy gotcha:** games logged before 2025-12-17 stored a bare array (just the evaluations, no territory data). Frontend readers must handle BOTH the old array format and the new object format; old games simply render without territory overlays. Do not assume the object shape when reading historic rows.
