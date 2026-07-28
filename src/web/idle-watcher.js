/* Idle-disconnect watcher for the centaur play WebSocket pages.
 *
 * Tracks user activity (keydown/click/mousemove + tab becoming visible),
 * periodically checks how long since the last activity, and when the user
 * has been idle past IDLE_TIMEOUT_MS:
 *   - closes the WebSocket with the shared idle close code/reason
 *   - shows an "inactive" overlay with a Reconnect button
 *   - tells the reconnect loop to stand down (so it doesn't immediately
 *     re-establish the very connection we just closed)
 *
 * Also sends a lightweight `activity` heartbeat to the server every couple
 * of minutes ONLY while the user has been active since the last beat. The
 * absence of these heartbeats is what lets the server independently sweep
 * idle sockets (in case the client tab is frozen / OS-suspended / buggy).
 *
 * Usage:
 *   const idle = IdleWatcher.attach({
 *     getWS: () => ws,
 *     reconnect: () => connectWebSocket(),
 *   });
 *   idle.onConnected();   // call from ws.onopen
 *   idle.onClose(event);  // call from ws.onclose; returns true if idle
 */
(function () {
  const POLICY = window.IdlePolicy || {
    IDLE_TIMEOUT_MS: 30 * 60 * 1000,
    IDLE_CLOSE_CODE: 4001,
    IDLE_CLOSE_REASON: 'idle-timeout',
    ACTIVITY_HEARTBEAT_INTERVAL_MS: 2 * 60 * 1000,
    IDLE_CHECK_INTERVAL_MS: 30 * 1000,
    WS_KEEPALIVE_INTERVAL_MS: 25 * 1000,
  };

  function buildOverlay() {
    const style = document.createElement('style');
    style.textContent = `
      .idle-overlay {
        display: none; position: fixed; inset: 0; z-index: 9000;
        background: rgba(0, 0, 0, 0.78);
        align-items: center; justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }
      .idle-overlay.active { display: flex; }
      .idle-overlay-box {
        background: #2a2a2a; border: 1px solid #555; border-radius: 10px;
        padding: 28px 32px; max-width: 420px; text-align: center;
        color: #e0e0e0; box-shadow: 0 10px 30px rgba(0,0,0,0.5);
      }
      .idle-overlay-box h2 { font-size: 20px; margin-bottom: 10px; }
      .idle-overlay-box p { color: #bbb; font-size: 14px; line-height: 1.5; margin-bottom: 18px; }
      .idle-overlay-box button {
        background: #4CAF50; color: white; border: none;
        padding: 10px 26px; border-radius: 6px; cursor: pointer;
        font-size: 15px; font-weight: 600;
      }
      .idle-overlay-box button:hover { background: #45a049; }
      .idle-overlay-hint { font-size: 11px; color: #888; margin-top: 10px; }
      body.idle-disconnected .ws-status,
      body.idle-disconnected .connection-status { opacity: 0.4; }
      body.idle-disconnected .timer-display { opacity: 0.4; }
    `;
    document.head.appendChild(style);

    const overlay = document.createElement('div');
    overlay.className = 'idle-overlay';
    overlay.innerHTML = `
      <div class="idle-overlay-box">
        <h2>Disconnected due to inactivity</h2>
        <p>Live updates are paused after 30 minutes without activity to save server cost. Reconnect to resume.</p>
        <button type="button" class="idle-reconnect-btn">Reconnect</button>
        <div class="idle-overlay-hint">Any click, tap, or key press will also reconnect.</div>
      </div>`;
    document.body.appendChild(overlay);
    return overlay;
  }

  class IdleWatcher {
    constructor(opts) {
      this.getWS = opts.getWS;
      this.reconnect = opts.reconnect;
      this.lastActivityAt = Date.now();
      this.lastHeartbeatAt = 0;
      this.idleTriggered = false;
      this.suppressReconnect = false;
      this.overlay = buildOverlay();
      this.reconnectBtn = this.overlay.querySelector('.idle-reconnect-btn');

      const onActivity = () => this._markActivity();
      ['keydown', 'mousedown', 'mousemove', 'touchstart', 'wheel'].forEach(ev => {
        document.addEventListener(ev, onActivity, { passive: true });
      });
      // NOTE: visibilitychange deliberately does NOT count as activity.
      // Merely focusing / switching back to a tab is passive presence, not
      // intent — counting it would let an abandoned-but-occasionally-focused
      // tab reset the idle clock (and auto-reconnect), keeping the autoscale
      // server alive with nobody actually interacting. Only real gestures
      // (key press, click, tap, scroll, mouse move) mark activity.

      this.reconnectBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._userInitiatedReconnect();
      });
      // Deliberate user interaction while the overlay is up also reconnects.
      // Only intentional gestures count (click / tap / key press) — passive
      // mouse movement or scrolling over the tab must NOT wake the server,
      // since it doesn't reflect an intent to interact with the game.
      const reconnectIfIdle = () => {
        if (this.idleTriggered) this._userInitiatedReconnect();
      };
      ['mousedown', 'touchstart', 'keydown'].forEach(ev => {
        document.addEventListener(ev, reconnectIfIdle, { passive: true });
      });

      this.checkInterval = setInterval(() => this._tick(),
        POLICY.IDLE_CHECK_INTERVAL_MS);

      // One-time fetch of the runtime-configurable idle timeout
      // (idleTimeoutMinutes on the /config page). A single request at page
      // load — no polling, so it can't keep the server alive by itself.
      // Falls back to the POLICY default if the fetch fails.
      fetch('/api/config')
        .then(r => r.json())
        .then(data => {
          const minutes = data && data.config && data.config.idleTimeoutMinutes;
          if (typeof minutes === 'number' && minutes > 0) {
            POLICY.IDLE_TIMEOUT_MS = minutes * 60 * 1000;
            const p = this.overlay.querySelector('.idle-overlay-box p');
            if (p) {
              p.textContent =
                `Live updates are paused after ${minutes} minute` +
                `${minutes === 1 ? '' : 's'} without activity to save ` +
                'server cost. Reconnect to resume.';
            }
          }
        })
        .catch(() => { /* keep default */ });

      // Unconditional connection keepalive. Sent on a steady cadence regardless
      // of whether the user has interacted, so a passive watcher never goes
      // silent and the proxy never drops the idle-but-open socket. This is
      // deliberately separate from the activity heartbeat: `keepalive` does NOT
      // count as user intent server-side, so it never resets the 30-minute idle
      // window — only genuine activity does.
      this.keepaliveInterval = setInterval(() => this._keepalive(),
        POLICY.WS_KEEPALIVE_INTERVAL_MS);
    }

    _markActivity() {
      this.lastActivityAt = Date.now();
    }

    /** Update the always-visible server-state badge (shared component from
     *  server-status-badge.js). state: 'active' | 'reconnecting' | 'idle' */
    _setBadge(state, label) {
      if (window.ServerStatusBadge) window.ServerStatusBadge.set(state, label);
    }

    _keepalive() {
      const ws = this.getWS && this.getWS();
      if (!ws || ws.readyState !== 1 /* OPEN */) return;
      try {
        ws.send(JSON.stringify({ type: 'keepalive' }));
      } catch (e) { /* ignore */ }
    }

    /** Returns true if the close was caused by us closing for idle, so the
     *  caller can suppress the auto-reconnect loop. */
    isIdleClose(event) {
      return !!(event && event.code === POLICY.IDLE_CLOSE_CODE);
    }

    shouldSuppressReconnect() {
      return this.suppressReconnect;
    }

    onConnected() {
      // Fresh connection — clear any latent idle state. Note: we do NOT
      // reset lastActivityAt on (re)connect because that would mean a tab
      // that just lost its socket would silently extend its idle window.
      // (This was once a real production bug: the proxy drops idle sockets
      // after ~5 minutes, the auto-reconnect loop reconnected, and a
      // _markActivity() call here reset the 30-minute idle clock on every
      // reconnect — so an abandoned tab held the autoscale deployment alive
      // 24/7. User-initiated reconnects mark activity in
      // _userInitiatedReconnect BEFORE reconnecting, so this must stay
      // activity-neutral.)
      this.suppressReconnect = false;
      this.idleTriggered = false;
      this.overlay.classList.remove('active');
      document.body.classList.remove('idle-disconnected');
      this._setBadge('active', 'Server active');
    }

    onClose(event) {
      // Regardless of WHY the socket closed (proxy timeout, network blip),
      // if the user is already past the idle window there is no reason to
      // auto-reconnect — doing so would keep the server alive with zero
      // humans watching. Treat it exactly like an idle close.
      if (!this.isIdleClose(event) &&
          Date.now() - this.lastActivityAt >= POLICY.IDLE_TIMEOUT_MS) {
        this.idleTriggered = true;
        this.suppressReconnect = true;
        this._showIdleOverlay();
        return true;
      }
      if (!this.isIdleClose(event)) {
        // Transient drop — the caller's auto-reconnect loop will retry.
        this._setBadge('reconnecting', 'Reconnecting…');
      }
      // If the close was the idle one (either initiated by us in _tick OR
      // by the server's sweep), leave the overlay up, suppress the caller's
      // reconnect loop, and arm the manual-reconnect path. Setting
      // idleTriggered here is what makes the Reconnect button / activity
      // reconnect work after a SERVER-initiated idle close — the client may
      // never have hit its own _tick threshold (e.g. backgrounded tab).
      if (this.isIdleClose(event)) {
        this.idleTriggered = true;
        this.suppressReconnect = true;
        this._showIdleOverlay();
        return true;
      }
      return false;
    }

    _tick() {
      const ws = this.getWS && this.getWS();
      if (!ws || ws.readyState !== 1 /* OPEN */) return;

      const now = Date.now();
      const idleFor = now - this.lastActivityAt;

      if (idleFor >= POLICY.IDLE_TIMEOUT_MS && !this.idleTriggered) {
        this.idleTriggered = true;
        this.suppressReconnect = true;
        try {
          ws.close(POLICY.IDLE_CLOSE_CODE, POLICY.IDLE_CLOSE_REASON);
        } catch (e) { /* ignore */ }
        this._showIdleOverlay();
        return;
      }

      // Heartbeat: only beat if the user has been active since the last
      // beat. The absence of heartbeats is the signal the server uses to
      // detect a dead/zombie tab.
      const sinceBeat = now - this.lastHeartbeatAt;
      if (sinceBeat >= POLICY.ACTIVITY_HEARTBEAT_INTERVAL_MS &&
          this.lastActivityAt > this.lastHeartbeatAt) {
        try {
          ws.send(JSON.stringify({ type: 'activity' }));
          this.lastHeartbeatAt = now;
        } catch (e) { /* ignore */ }
      }
    }

    _showIdleOverlay() {
      this.overlay.classList.add('active');
      document.body.classList.add('idle-disconnected');
      this._setBadge('idle', 'Server idle');
    }

    _userInitiatedReconnect() {
      if (!this.idleTriggered) return;
      this.idleTriggered = false;
      this.suppressReconnect = false;
      this.overlay.classList.remove('active');
      document.body.classList.remove('idle-disconnected');
      this._setBadge('reconnecting', 'Reconnecting…');
      this._markActivity();
      if (typeof this.reconnect === 'function') {
        try { this.reconnect(); } catch (e) { console.error(e); }
      }
    }
  }

  window.IdleWatcher = {
    attach(opts) { return new IdleWatcher(opts || {}); },
    POLICY,
  };
})();
