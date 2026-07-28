import {
  pgTable,
  serial,
  varchar,
  integer,
  text,
  jsonb,
  timestamp,
  index,
  boolean,
} from 'drizzle-orm/pg-core';

/**
 * Drizzle schema definitions — the single source of truth for the database
 * shape. `db:push` (dev) and Replit's Publish diff (prod) apply this schema.
 * These tables reproduce the previously-startup-created schema exactly; do not
 * add or rename columns here without an accompanying migration plan.
 */

// Per-move decision log written asynchronously by the DecisionLogger worker and
// read back by the history viewer.
export const decisionLogs = pgTable(
  'decision_logs',
  {
    id: serial('id').primaryKey(),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
    gameId: varchar('game_id', { length: 255 }).notNull(),
    snakeId: varchar('snake_id', { length: 255 }).notNull(),
    snakeName: varchar('snake_name', { length: 255 }),
    turn: integer('turn').notNull(),
    positionX: integer('position_x').notNull(),
    positionY: integer('position_y').notNull(),
    health: integer('health').notNull(),
    safeMoves: text('safe_moves').array(),
    botRecommendation: varchar('bot_recommendation', { length: 10 }).notNull(),
    submittedMove: varchar('submitted_move', { length: 10 }),
    // True when the submitted move went through the fatal-move consent
    // confirmation (dialog confirm or kill-all). Null on rows logged before
    // this column existed or before the move was back-filled.
    fatalConsent: boolean('fatal_consent'),
    serverMove: varchar('server_move', { length: 10 }),
    moveEvaluations: jsonb('move_evaluations').notNull(),
    gameState: jsonb('game_state').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    index('idx_decision_logs_game_id').on(table.gameId),
    index('idx_decision_logs_snake_id').on(table.snakeId),
    index('idx_decision_logs_turn').on(table.turn),
    index('idx_decision_logs_timestamp').on(table.timestamp),
    index('idx_decision_logs_game_snake_turn').on(table.gameId, table.snakeId, table.turn),
  ],
);

// Server lifecycle/activity events (boot, shutdown, woke, went-idle) powering
// the /activity autoscale audit page. Dev and prod databases are separate, so
// each database's rows are inherently their own environment — no env column.
export const serverEvents = pgTable(
  'server_events',
  {
    id: serial('id').primaryKey(),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
    eventType: varchar('event_type', { length: 32 }).notNull(),
    detail: jsonb('detail'),
  },
  table => [index('idx_server_events_timestamp').on(table.timestamp)],
);

// Simple key/value configuration store backing the config UI.
export const configStore = pgTable('config_store', {
  key: varchar('key', { length: 255 }).primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at').defaultNow(),
});
