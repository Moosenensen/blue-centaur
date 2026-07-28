/* WebSocket connection debugger - client side helper.
 *
 * Wraps a WebSocket lifecycle to:
 *  - Track connection state (connecting/connected/disconnected/reconnecting/error)
 *  - Count opens/closes/errors and remember the last close code/reason
 *  - Report every event to the server so it ends up in the log file
 *  - Render a compact, draggable status panel with event history
 *
 * Usage:
 *   const dbg = ConnectionDebugger.attach({ gameId, userId });
 *   ws.addEventListener('open',  () => dbg.onOpen());
 *   ws.addEventListener('close', e => dbg.onClose(e));
 *   ws.addEventListener('error', e => dbg.onError(e));
 *   dbg.onReconnectAttempt();
 */
(function () {
  const STORAGE_KEY = 'wsDebugConnId';

  function getOrCreateConnId() {
    let id = sessionStorage.getItem(STORAGE_KEY);
    if (!id) {
      id = 'b' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
      sessionStorage.setItem(STORAGE_KEY, id);
    }
    return id;
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour12: false }) + '.' +
      String(d.getMilliseconds()).padStart(3, '0');
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtDur(ms) {
    if (ms == null) return '';
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return m + 'm ' + s + 's';
  }

  class ConnectionDebugger {
    constructor(opts) {
      this.gameId = opts.gameId || null;
      this.userId = opts.userId || null;
      this.connId = getOrCreateConnId();
      this.serverConnId = null;
      this.state = 'idle';
      this.openedAt = null;
      this.events = [];
      this.counters = { opens: 0, closes: 0, errors: 0, reconnects: 0 };
      this.lastClose = null;
      this.durationTimer = null;
      this.queueKey = 'wsDebugQueue';
      this.maxQueue = 200;
      this.flushing = false;
      this._buildPanel();
      this._installVisibilityHooks();
      // Try to flush anything that was stranded in a previous tab/session.
      this._flushQueue();
    }

    _readQueue() {
      try {
        const raw = localStorage.getItem(this.queueKey);
        return raw ? JSON.parse(raw) : [];
      } catch (e) { return []; }
    }
    _writeQueue(q) {
      try {
        if (q.length > this.maxQueue) q = q.slice(q.length - this.maxQueue);
        localStorage.setItem(this.queueKey, JSON.stringify(q));
      } catch (e) { /* quota / privacy mode — best effort */ }
    }
    _enqueue(event) {
      const q = this._readQueue();
      q.push(event);
      this._writeQueue(q);
    }

    /** Send all queued events to the server. Stops on the first failure so we
     *  don't reorder events; the rest get retried on the next call. */
    async _flushQueue() {
      if (this.flushing) return;
      this.flushing = true;
      try {
        let q = this._readQueue();
        while (q.length > 0) {
          const ev = q[0];
          let ok = false;
          try {
            const r = await fetch('/api/connection-log/client', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(ev),
            });
            ok = r.ok;
          } catch (e) {
            ok = false;
          }
          if (!ok) break;
          q.shift();
          this._writeQueue(q);
        }
      } finally {
        this.flushing = false;
      }
    }

    _record(type, extra) {
      const event = Object.assign({
        ts: Date.now(),
        type,
        connId: this.connId,
        serverConnId: this.serverConnId || undefined,
        gameId: this.gameId || undefined,
        userId: this.userId || undefined,
      }, extra || {});
      this.events.push(event);
      if (this.events.length > 200) this.events.shift();
      this._renderEvents();

      // Always queue first so a failed POST (the very thing we want to record
      // when the network drops) doesn't get lost. The flush either succeeds
      // immediately or retries on the next event / on reconnect.
      this._enqueue(event);

      // AUTOSCALE HYGIENE: while the socket is closed (idle-disconnected or
      // dropped), this tab must generate ZERO HTTP traffic — a POST from a
      // passive tab is an inbound request that wakes / keeps up the autoscale
      // instance. Events stay queued in localStorage and drain on the next
      // real (deliberate) reconnect via onOpen()'s flush.
      if (this.state !== 'connected') return;

      // For unload/page-hide we use sendBeacon — fetch in a tearing-down page
      // is unreliable even with keepalive; sendBeacon is the spec-blessed path.
      const isUnload =
        type === 'client-page-unload' || type === 'client-page-hidden';
      if (isUnload && navigator.sendBeacon) {
        try {
          const blob = new Blob([JSON.stringify(event)], { type: 'application/json' });
          if (navigator.sendBeacon('/api/connection-log/client', blob)) {
            // Beacon accepted — drop just this event from the queue head.
            const q = this._readQueue();
            if (q.length && q[q.length - 1].ts === event.ts && q[q.length - 1].type === event.type) {
              q.pop();
              this._writeQueue(q);
            }
            return;
          }
        } catch (e) { /* fall through to fetch flush */ }
      }

      this._flushQueue();
    }

    _setState(state) {
      this.state = state;
      this.statusEl.textContent = state;
      this.statusEl.className = 'wsdbg-status wsdbg-' + state;
    }

    onOpen() {
      this.counters.opens++;
      this.openedAt = Date.now();
      this._setState('connected');
      this._record('client-open');
      this._renderHeader();
      this._startDurationTimer();
      // Network is back — drain anything that was queued while offline
      // (most importantly the client-close/error from the previous outage).
      this._flushQueue();
    }

    onClose(event) {
      this.counters.closes++;
      const durationMs = this.openedAt ? Date.now() - this.openedAt : undefined;
      this.openedAt = null;
      this._stopDurationTimer();
      const code = event && typeof event.code === 'number' ? event.code : undefined;
      const reason = event && event.reason ? String(event.reason) : '';
      const wasClean = event && typeof event.wasClean === 'boolean' ? event.wasClean : undefined;
      this.lastClose = { ts: Date.now(), code, reason, wasClean, durationMs };
      this._setState('disconnected');
      // Record the close event while the previous serverConnId is still valid
      // (so the close ties back to the right socket), then clear it so events
      // before the next debug-hello aren't tagged with a stale server id.
      this._record('client-close', { code, reason, durationMs, details: { wasClean } });
      this.serverConnId = null;
      this._renderHeader();
    }

    onError(event) {
      this.counters.errors++;
      const message = event && event.message
        ? String(event.message)
        : (event && event.type ? 'event:' + event.type : 'unknown error');
      this._record('client-error', { message });
      this._renderHeader();
    }

    onReconnectAttempt() {
      this.counters.reconnects++;
      this._setState('reconnecting');
      this._record('client-reconnect-attempt');
      this._renderHeader();
    }

    setIds(gameId, userId) {
      if (gameId) this.gameId = gameId;
      if (userId) this.userId = userId;
    }

    setServerConnId(id) {
      if (typeof id === 'string' && id) this.serverConnId = id;
    }

    _installVisibilityHooks() {
      document.addEventListener('visibilitychange', () => {
        const type = document.hidden ? 'client-page-hidden' : 'client-page-visible';
        this._record(type);
      });
      window.addEventListener('pagehide', () => {
        this._record('client-page-unload', { reason: 'pagehide' });
      });
      window.addEventListener('beforeunload', () => {
        this._record('client-page-unload', { reason: 'beforeunload' });
      });
    }

    _startDurationTimer() {
      this._stopDurationTimer();
      this.durationTimer = setInterval(() => this._renderHeader(), 1000);
    }
    _stopDurationTimer() {
      if (this.durationTimer) { clearInterval(this.durationTimer); this.durationTimer = null; }
    }

    _buildPanel() {
      const style = document.createElement('style');
      style.textContent = `
        .wsdbg-panel {
          position: fixed; right: 12px; bottom: 12px; width: 320px; z-index: 9999;
          background: #1f1f1f; color: #e0e0e0; border: 1px solid #444;
          border-radius: 6px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-size: 12px; box-shadow: 0 4px 14px rgba(0,0,0,0.4);
        }
        .wsdbg-header {
          display: flex; justify-content: space-between; align-items: center;
          padding: 8px 10px; border-bottom: 1px solid #333; cursor: pointer;
          user-select: none;
        }
        .wsdbg-header strong { font-size: 12px; }
        .wsdbg-status {
          font-size: 10px; padding: 2px 8px; border-radius: 10px; text-transform: uppercase;
          font-weight: 600; letter-spacing: 0.5px;
        }
        .wsdbg-idle, .wsdbg-connecting { background: #e65100; color: #ffe0b2; }
        .wsdbg-connected { background: #2e7d32; color: #c8e6c9; }
        .wsdbg-disconnected { background: #c62828; color: #ffcdd2; }
        .wsdbg-reconnecting { background: #6a1b9a; color: #e1bee7; }
        .wsdbg-body { padding: 8px 10px; }
        .wsdbg-meta { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 10px; margin-bottom: 8px; }
        .wsdbg-meta div { color: #aaa; }
        .wsdbg-meta b { color: #e0e0e0; font-weight: 500; }
        .wsdbg-section-title {
          font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 0.5px;
          margin: 6px 0 4px;
        }
        .wsdbg-events {
          max-height: 180px; overflow: auto;
          background: #161616; border: 1px solid #2a2a2a; border-radius: 4px;
          font-family: monospace; font-size: 11px;
        }
        .wsdbg-event { padding: 3px 6px; border-bottom: 1px solid #222; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .wsdbg-event.client-open { color: #a5d6a7; }
        .wsdbg-event.client-close { color: #ef9a9a; }
        .wsdbg-event.client-error { color: #ffab91; }
        .wsdbg-event.client-reconnect-attempt { color: #ffe082; }
        .wsdbg-event.client-page-hidden,
        .wsdbg-event.client-page-visible,
        .wsdbg-event.client-page-unload { color: #ce93d8; }
        .wsdbg-actions { display: flex; gap: 6px; margin-top: 6px; }
        .wsdbg-actions a, .wsdbg-actions button {
          flex: 1; text-align: center; background: #333; color: #4CAF50;
          border: 1px solid #555; padding: 4px 6px; border-radius: 3px;
          font-size: 11px; cursor: pointer; text-decoration: none;
        }
        .wsdbg-actions button:hover, .wsdbg-actions a:hover { background: #444; }
        .wsdbg-collapsed .wsdbg-body { display: none; }
      `;
      document.head.appendChild(style);

      const panel = document.createElement('div');
      panel.className = 'wsdbg-panel';
      panel.innerHTML = `
        <div class="wsdbg-header">
          <strong>WS Debugger</strong>
          <span class="wsdbg-status wsdbg-idle">idle</span>
        </div>
        <div class="wsdbg-body">
          <div class="wsdbg-meta">
            <div>State: <b class="wsdbg-state">idle</b></div>
            <div>Up: <b class="wsdbg-uptime">–</b></div>
            <div>Opens: <b class="wsdbg-opens">0</b></div>
            <div>Closes: <b class="wsdbg-closes">0</b></div>
            <div>Errors: <b class="wsdbg-errors">0</b></div>
            <div>Reconnects: <b class="wsdbg-reconnects">0</b></div>
          </div>
          <div class="wsdbg-meta">
            <div style="grid-column: span 2;">Last close: <b class="wsdbg-lastclose">–</b></div>
          </div>
          <div class="wsdbg-section-title">Recent events</div>
          <div class="wsdbg-events"></div>
          <div class="wsdbg-actions">
            <a href="/connection-debug" target="_blank">Full log</a>
            <a href="/api/connection-log/download">Download</a>
            <button class="wsdbg-clear">Clear</button>
          </div>
        </div>
      `;
      document.body.appendChild(panel);

      this.panel = panel;
      this.statusEl = panel.querySelector('.wsdbg-status');
      this.eventsEl = panel.querySelector('.wsdbg-events');

      panel.querySelector('.wsdbg-header').addEventListener('click', () => {
        panel.classList.toggle('wsdbg-collapsed');
      });
      panel.querySelector('.wsdbg-clear').addEventListener('click', (e) => {
        e.stopPropagation();
        this.events = [];
        this._renderEvents();
      });

      this._setState('idle');
      this._renderHeader();
    }

    _renderHeader() {
      const p = this.panel;
      p.querySelector('.wsdbg-state').textContent = this.state;
      p.querySelector('.wsdbg-opens').textContent = this.counters.opens;
      p.querySelector('.wsdbg-closes').textContent = this.counters.closes;
      p.querySelector('.wsdbg-errors').textContent = this.counters.errors;
      p.querySelector('.wsdbg-reconnects').textContent = this.counters.reconnects;
      p.querySelector('.wsdbg-uptime').textContent =
        this.openedAt ? fmtDur(Date.now() - this.openedAt) : '–';
      p.querySelector('.wsdbg-lastclose').textContent = this.lastClose
        ? `${fmtTime(this.lastClose.ts)}  code=${this.lastClose.code ?? '?'} ` +
          (this.lastClose.reason ? `"${this.lastClose.reason}"` : '(no reason)') +
          (this.lastClose.wasClean === false ? ' (unclean)' : '')
        : '–';
    }

    _renderEvents() {
      const recent = this.events.slice(-50).reverse();
      this.eventsEl.innerHTML = recent.map(e => {
        const extras = [];
        if (e.code !== undefined) extras.push('code=' + e.code);
        if (e.reason) extras.push('"' + escapeHtml(e.reason) + '"');
        if (e.message) extras.push(escapeHtml(e.message));
        if (e.durationMs !== undefined) extras.push('dur=' + fmtDur(e.durationMs));
        return `<div class="wsdbg-event ${escapeHtml(e.type)}">${escapeHtml(fmtTime(e.ts))} ${escapeHtml(e.type)}${extras.length ? ' · ' + extras.join(' ') : ''}</div>`;
      }).join('') || '<div class="wsdbg-event" style="color:#666">No events yet.</div>';
    }
  }

  window.ConnectionDebugger = {
    attach(opts) { return new ConnectionDebugger(opts || {}); }
  };
})();
