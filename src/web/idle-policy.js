// Client mirror of src/shared/idle-policy.ts. Keep these constants in sync.
window.IdlePolicy = {
  // Default only — idle-watcher.js overwrites this at page load from the
  // runtime config (idleTimeoutMinutes on the /config page).
  IDLE_TIMEOUT_MS: 30 * 60 * 1000,
  IDLE_CLOSE_CODE: 4001,
  IDLE_CLOSE_REASON: 'idle-timeout',
  ACTIVITY_HEARTBEAT_INTERVAL_MS: 2 * 60 * 1000,
  IDLE_CHECK_INTERVAL_MS: 30 * 1000,
  // Unconditional connection keepalive cadence (mirrors WS_KEEPALIVE_INTERVAL_MS
  // in src/shared/idle-policy.ts). Sent regardless of user activity so a passive
  // watcher never goes silent and the proxy never drops the idle-but-open socket.
  WS_KEEPALIVE_INTERVAL_MS: 25 * 1000,
};
