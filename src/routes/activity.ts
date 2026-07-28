import express from 'express';
import { and, asc, gte, lte } from 'drizzle-orm';
import { db } from '../database/db';
import { serverEvents } from '../database/schema';

const router = express.Router();

const MAX_EVENTS = 20000;

// Server activity events for a time range (both bounds as epoch millis).
// Returned ascending by timestamp; capped so a huge range can't blow up the
// response. The client renders bands/markers entirely from these events.
router.get('/api/activity/events', async (req, res) => {
  try {
    const startMs = req.query.start ? Number(req.query.start) : NaN;
    const endMs = req.query.end ? Number(req.query.end) : NaN;
    const limit = Math.min(
      req.query.limit ? Math.max(1, Number(req.query.limit) || MAX_EVENTS) : MAX_EVENTS,
      MAX_EVENTS,
    );

    const conditions = [];
    if (Number.isFinite(startMs)) conditions.push(gte(serverEvents.timestamp, new Date(startMs)));
    if (Number.isFinite(endMs)) conditions.push(lte(serverEvents.timestamp, new Date(endMs)));

    const rows = await db
      .select({
        id: serverEvents.id,
        timestamp: serverEvents.timestamp,
        eventType: serverEvents.eventType,
        detail: serverEvents.detail,
      })
      .from(serverEvents)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(serverEvents.timestamp), asc(serverEvents.id))
      .limit(limit);

    res.json({
      events: rows.map(r => ({
        id: r.id,
        ts: r.timestamp instanceof Date ? r.timestamp.getTime() : new Date(r.timestamp as any).getTime(),
        type: r.eventType,
        detail: r.detail ?? null,
      })),
      truncated: rows.length >= limit,
      serverNow: Date.now(),
    });
  } catch (error) {
    console.error('Error fetching activity events:', error);
    res.status(500).json({ error: 'Failed to fetch activity events' });
  }
});

export default router;
