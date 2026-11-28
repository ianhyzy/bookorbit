import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Pool } from 'pg';

/**
 * Schema additions that belong to this personal fork, kept out of the Drizzle journal so they never
 * collide with upstream's numbered migrations. Every file in `migrations/fork/` runs on every start,
 * in name order, so each statement must be safe to repeat (IF NOT EXISTS and friends).
 */
export async function applyForkMigrations(pool: Pool, migrationsFolder: string): Promise<void> {
  const folder = join(migrationsFolder, 'fork');
  if (!existsSync(folder)) return;

  const files = readdirSync(folder)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const name of files) {
    await pool.query(readFileSync(join(folder, name), 'utf8'));
  }
  if (files.length > 0) console.log(`Fork migrations applied: ${files.join(', ')}`);
}
