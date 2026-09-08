/**
 * Database handle.
 *
 * `enableChangeListener` powers drizzle's `useLiveQuery`, so screens re-render
 * when data changes without any manual invalidation. Worth the small overhead:
 * almost every screen in this app is a view over local state that something
 * else just wrote.
 */

import { drizzle } from 'drizzle-orm/expo-sqlite';
import { openDatabaseSync } from 'expo-sqlite';
import * as schema from './schema';

export const expoDb = openDatabaseSync('upsc-mentor.db', {
  enableChangeListener: true,
});

/**
 * SQLite parses FOREIGN KEY clauses but does not enforce them — or run ON
 * DELETE actions — unless this pragma is set. It is off by default, is not a
 * persisted property of the file, and must be set on every connection at every
 * app launch. Neither expo-sqlite nor drizzle sets it. Without this line the
 * `.references()` declarations in schema.ts are decorative.
 */
expoDb.execSync('PRAGMA foreign_keys = ON;');

export const db = drizzle(expoDb, { schema });

export { schema };
export type Database = typeof db;
