import express from 'express';
import { ConnectionLogger, ConnectionEvent, ConnectionEventType } from '../utils/connection-logger';

const router = express.Router();

const VALID_CLIENT_TYPES: ConnectionEventType[] = [
  'client-open',
  'client-close',
  'client-error',
  'client-reconnect-attempt',
  'client-idle-close',
  'client-page-hidden',
  'client-page-visible',
  'client-page-unload',
];

router.get('/api/connection-log/recent', (req, res) => {
  const logger = ConnectionLogger.getInstance();
  const limit = Math.min(parseInt((req.query.limit as string) || '200', 10) || 200, 1000);
  res.json({
    stats: logger.getStats(),
    events: logger.getRecent(limit),
  });
});

router.get('/api/connection-log/download', (req, res) => {
  const logger = ConnectionLogger.getInstance();
  res.download(logger.getLogFilePath(), 'ws-connections.log');
});

router.post('/api/connection-log/client', express.json({ limit: '64kb' }), (req, res) => {
  const logger = ConnectionLogger.getInstance();
  const body = req.body || {};
  const type = body.type as ConnectionEventType;

  if (!VALID_CLIENT_TYPES.includes(type)) {
    res.status(400).json({ error: 'invalid event type' });
    return;
  }

  const ip =
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown';

  const cap = (v: unknown, n: number) =>
    typeof v === 'string' ? v.slice(0, n) : undefined;

  const event: ConnectionEvent = {
    ts: Date.now(),
    side: 'client',
    type,
    connId: cap(body.connId, 64),
    serverConnId: cap(body.serverConnId, 64),
    gameId: cap(body.gameId, 128),
    userId: cap(body.userId, 128),
    ip,
    userAgent: (req.headers['user-agent'] as string) || 'unknown',
    code: typeof body.code === 'number' ? body.code : undefined,
    reason: cap(body.reason, 256),
    message: cap(body.message, 512),
    durationMs: typeof body.durationMs === 'number' ? body.durationMs : undefined,
    details: typeof body.details === 'object' && body.details ? body.details : undefined,
  };

  logger.log(event);
  res.json({ ok: true });
});

export default router;
