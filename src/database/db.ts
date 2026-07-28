import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

/**
 * Shared database access. A single pg Pool backs one Drizzle client for the
 * whole process, replacing the previous per-class `new Pool(...)` instances.
 * Import { db } for queries and { pool } for lifecycle (shutdown) needs.
 */
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

export const db = drizzle(pool, { schema });

export { schema };
