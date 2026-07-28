---
name: Server activity timeline
description: Constraints on the /activity autoscale audit feature and its event model
---
The /activity page audits autoscale scale-to-zero behavior, so it must NEVER generate background traffic itself: no auto-refresh timers, data loads only on explicit user actions (zoom/pan/range change), and server-side timers touching this feature must be unref'd and cheap.

**Why:** the feature exists because an abandoned tab's reconnect loop kept the deployment billed 24/7; a polling viewer page would recreate the exact problem it audits.

**How to apply:** any change to activity pages or ServerEventLogger — keep writes fire-and-forget (never block /move or shutdown; shutdown flush is timeout-bounded), keep the "active" definition = WS connections > 0 OR game request within 60s, and emit exactly one woke/went-idle per transition. Workflow restarts often SIGKILL, so missing shutdown events are normal — periods are implicitly closed by the next boot and shown as "end unknown".
