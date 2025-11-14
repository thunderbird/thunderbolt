import { migrations } from '@/drizzle/_migrations'
import { sql } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from './database-interface'

export type ProxyMigrator = (migrationQueries: string[]) => Promise<void>

/**
 * Splits a SQL string into separate statements
 * @param sql SQL string that may contain multiple statements
 * @returns Array of SQL statements
 */
function splitSqlStatements(sql: string): string[] {
  // Split by semicolons, but handle the special case of statement-breakpoint comments
  return sql
    .split(/(?:-->\s*statement-breakpoint|;)/g)
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0)
}

/**
 * Executes database migrations.
 *
 * @returns A promise that resolves when the migrations are complete.
 */
export async function migrate(db: AnyDrizzleDatabase) {
  const startTime = performance.now()

  // Optimization: Try to query the table first (fast DML), only create if it doesn't exist (slow DDL)
  // This avoids the expensive CREATE TABLE IF NOT EXISTS on OPFS/IndexedDB (465ms!) when table exists
  let rows: unknown[]

  try {
    // Try to select from the table - this is fast if the table exists
    rows = await db.all(sql`SELECT id, hash, created_at FROM "__drizzle_migrations" ORDER BY created_at DESC`)
  } catch (_error) {
    // Table doesn't exist, create it
    await db.run(sql`
		CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            hash text NOT NULL UNIQUE,
			created_at numeric
		)
	`)
    // Now it's empty
    rows = []
  }

  // Convert the rows to a Set for O(1) lookups
  const completedMigrationHashes = new Set<string>(
    rows.map((row: unknown) => {
      const [, hash] = row as [unknown, string, unknown]
      return hash
    }),
  )

  const hasBeenRun = (hash: string) => completedMigrationHashes.has(hash)

  // Apply migrations that haven't been run yet
  let migrationsRun = 0

  for (const migration of migrations) {
    if (!hasBeenRun(migration.hash)) {
      try {
        // Split migration into separate statements and execute each one
        const statements = splitSqlStatements(migration.sql)

        for (const statement of statements) {
          try {
            await db.run(sql.raw(statement))
          } catch (statementError) {
            console.error(`Error executing statement in migration ${migration.name}:`, statementError)
            console.error('Statement:', statement)
            throw statementError
          }
        }

        // Record the migration as complete
        await db.run(
          sql`INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (${migration.hash}, ${Date.now()})`,
        )
        migrationsRun++
      } catch (error) {
        console.error(`Failed to apply migration ${migration.name}:`, error)
        throw error
      }
    }
  }

  const elapsedMs = Math.round(performance.now() - startTime)
  console.info(`Ran ${migrationsRun} migration${migrationsRun === 1 ? '' : 's'} in ${elapsedMs} ms`)

  return Promise.resolve()
}
