/* Shared server-status badge.
 *
 * A small fixed pill (bottom-left) showing whether this page is keeping the
 * server active:
 *   - green  "Server active"   — page has a live claim on the server
 *   - amber  "Reconnecting…"   — transient drop, being restored
 *   - grey   "Server idle"     — idle window elapsed; page has released the server
 *
 * Only used on pages with a live WebSocket (play lobby / game viewer), where
 * idle-watcher.js drives it via window.ServerStatusBadge.set(state, label).
 * Static pages (history / config) deliberately do NOT show this badge: they
 * hold no live connection, so a status there would always read "active" and
 * communicate nothing — and any polling to make it meaningful would itself
 * keep the autoscale deployment alive (the exact bug this plumbing exists
 * to prevent).
 */
(function () {
  let badge = null;
  let label = null;

  function ensureBadge() {
    if (badge) return badge;
    const style = document.createElement('style');
    style.textContent = `
      .server-state-badge {
        position: fixed; bottom: 14px; left: 14px; z-index: 9500;
        display: flex; align-items: center; gap: 7px;
        padding: 6px 12px; border-radius: 999px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 12px; font-weight: 600; letter-spacing: 0.02em;
        background: rgba(30, 30, 30, 0.92); border: 1px solid #444;
        color: #e0e0e0; box-shadow: 0 2px 10px rgba(0,0,0,0.4);
        pointer-events: none; user-select: none;
      }
      .server-state-badge .dot {
        width: 9px; height: 9px; border-radius: 50%;
        background: #888; flex: 0 0 auto;
      }
      .server-state-badge.state-active .dot {
        background: #4CAF50;
        box-shadow: 0 0 6px rgba(76, 175, 80, 0.8);
        animation: server-badge-pulse 2s ease-in-out infinite;
      }
      .server-state-badge.state-active { border-color: #3c6e3e; }
      .server-state-badge.state-reconnecting .dot { background: #FFC107; }
      .server-state-badge.state-reconnecting { border-color: #8a6d1a; }
      .server-state-badge.state-idle .dot { background: #777; }
      .server-state-badge.state-idle { color: #999; }
      @keyframes server-badge-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.45; }
      }
    `;
    document.head.appendChild(style);

    badge = document.createElement('div');
    badge.className = 'server-state-badge state-reconnecting';
    badge.innerHTML =
      '<span class="dot"></span><span class="server-state-label">Connecting…</span>';
    document.body.appendChild(badge);
    label = badge.querySelector('.server-state-label');
    return badge;
  }

  function set(state, text) {
    ensureBadge();
    badge.className = 'server-state-badge state-' + state;
    label.textContent = text;
  }

  window.ServerStatusBadge = { set };
})();
