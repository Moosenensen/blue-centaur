---
name: Idle reconnect loop kept autoscale billing 24/7
description: How an abandoned tab defeated the idle-disconnect plumbing and held the deployment alive; invariants to preserve.
---

# Idle reconnect loop → continuous autoscale billing

The proxy in front of the deployed app drops idle WebSockets at ~300s (close code 1006). The client auto-reconnect loop then reconnects. Two bugs made this loop immortal, so one abandoned tab kept the autoscale deployment (and billing) alive for days:

1. **Client**: `IdleWatcher.onConnected()` called `_markActivity()` on every (auto-)reconnect, resetting the 30-min idle clock each 5-min cycle.
2. **Server**: each reconnect created a fresh `lastActivityAt`, and `subscribe-game`/`subscribe-lobby` counted as user intent — so no connection ever lived long enough to look idle to the sweep.

**Invariants to preserve:**
- Connect/reconnect and subscribe messages must NEVER count as user activity. Only genuine intent messages and explicit user gestures do.
- The server persists last-real-activity per `userId` across reconnects (`userActivity` map, restored on subscribe, pruned in the sweep).
- On any non-idle close, the client suppresses auto-reconnect if local inactivity already exceeds the idle window.

**Why:** multiple days of 24h billing at full autoscale rate from a single forgotten tab (diagnosed July 2026 from deployment logs: reconnect every ~301s for days).

**How to apply:** any new WS message type or reconnect path must be checked against these invariants; keepalives/pings/pongs are liveness only, never activity.

## Scale-to-zero timing (verified 2026-07-22)

Replit autoscale shuts the instance down after **15 minutes** with no inbound requests — not 5. Billing is for CPU/memory during request processing, so an up-but-idle tail is expected and mostly unbilled. When auditing the /activity timeline, an amber "up but idle" band of up to ~15 min after the last request is normal platform behavior, not an app bug. Outbound traffic (engine ping, DB queries) does not count as requests and does not delay scale-down.

## Timeline "active" = intent only (2026-07-22)

/activity "active" requires a state-mutating WS message (USER_INTENT_TYPES minus the `activity` heartbeat, 3-min window) or /start//move traffic (60s window). Open WS connections alone are "up but idle". Passive tabs are network-silent while disconnected: connection-log events queue in localStorage and flush on the next deliberate reconnect; tab-focus (visibilitychange) never counts as activity. When idle, server makes no background traffic: engine ping skipped with 0 games, idle-sweep config read skipped with 0 clients.
