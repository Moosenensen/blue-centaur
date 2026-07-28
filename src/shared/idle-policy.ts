// Shared idle-disconnect policy for the centaur play WebSocket connections.
// Client mirror lives at src/web/idle-policy.js — keep the constants in sync.

// NOTE: the idle timeout itself is runtime-configurable via the config store
// (`idleTimeoutMinutes` in game-config / the /config page). Server and client
// both read it from config; the DEFAULT_CONFIG value (30 min) is the fallback.
export const IDLE_CLOSE_CODE = 4001;
export const IDLE_CLOSE_REASON = 'idle-timeout';
export const ACTIVITY_HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000;
export const SERVER_IDLE_SWEEP_INTERVAL_MS = 60 * 1000;

// Connection keepalive interval. Both the server (protocol ping + app-level
// keepalive) and the client (unconditional app-level keepalive) fire on this
// cadence to keep an idle-but-open socket warm so the proxy in front of the app
// never drops it (~5-minute idle window). Comfortably under that window.
export const WS_KEEPALIVE_INTERVAL_MS = 25 * 1000;
