import { sql } from 'drizzle-orm';
import { db } from '../database/db';
import { configStore } from '../database/schema';

/**
 * Configuration store using PostgreSQL via Drizzle.
 * Stores configuration values as key-value pairs in the config_store table.
 * The schema is managed by Drizzle (db:push / Publish diff); this class assumes
 * the table already exists.
 */
export class ConfigStore {
  /**
   * Get all configuration values
   */
  async getAll(): Promise<Record<string, any>> {
    try {
      const rows = await db
        .select({ key: configStore.key, value: configStore.value })
        .from(configStore);
      const config: Record<string, any> = {};

      for (const row of rows) {
        try {
          config[row.key] = JSON.parse(row.value);
        } catch {
          config[row.key] = row.value;
        }
      }

      return config;
    } catch (error) {
      console.error('Error reading config from database:', error);
      return {};
    }
  }

  /**
   * Set a configuration value
   */
  async set(key: string, value: any): Promise<void> {
    try {
      const jsonValue = JSON.stringify(value);
      await db
        .insert(configStore)
        .values({ key, value: jsonValue, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: configStore.key,
          set: { value: jsonValue, updatedAt: new Date() },
        });
      console.log(`Config updated: ${key} = ${value}`);
    } catch (error) {
      console.error('Error saving config to database:', error);
      throw error;
    }
  }

  /**
   * Set multiple configuration values at once
   */
  async setMultiple(updates: Record<string, any>): Promise<void> {
    try {
      await db.transaction(async tx => {
        for (const [key, value] of Object.entries(updates)) {
          const jsonValue = JSON.stringify(value);
          await tx
            .insert(configStore)
            .values({ key, value: jsonValue, updatedAt: new Date() })
            .onConflictDoUpdate({
              target: configStore.key,
              set: { value: jsonValue, updatedAt: new Date() },
            });
        }
      });
      console.log(`Config updated with ${Object.keys(updates).length} values`);
    } catch (error) {
      console.error('Error saving config to database:', error);
      throw error;
    }
  }

  /**
   * Get a specific configuration value
   */
  async get(key: string): Promise<any> {
    try {
      const rows = await db
        .select({ value: configStore.value })
        .from(configStore)
        .where(sql`${configStore.key} = ${key}`);

      if (rows.length === 0) {
        return undefined;
      }

      try {
        return JSON.parse(rows[0].value);
      } catch {
        return rows[0].value;
      }
    } catch (error) {
      console.error('Error getting config from database:', error);
      return undefined;
    }
  }

  /**
   * Clear all configuration values
   */
  async clear(): Promise<void> {
    try {
      await db.delete(configStore);
      console.log('Config cleared');
    } catch (error) {
      console.error('Error clearing config:', error);
      throw error;
    }
  }
}
