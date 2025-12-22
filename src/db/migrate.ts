import { migrations } from '@/drizzle/_migrations'
import { sql } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from './database-interface'

export type ProxyMigrator = (migrationQueries: string[]) => Promise<void>

/**
 * Get the latest migration version hash
 * Used for sync version compatibility checking between devices
 */
export function getLatestMigrationVersion(): string {
  return migrations[migrations.length - 1]?.hash ?? '0000_initial'
}

/**
 * List of tables to mark as CRRs (Conflict-free Replicated Relations) for cr-sqlite sync
 */
const CRR_TABLES = [
  'settings',
  'chat_threads',
  'chat_messages',
  'tasks',
  'models',
  'mcp_servers',
  'prompts',
  'triggers',
] as const

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

  await db.run(sql`
		CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            hash text NOT NULL UNIQUE,
			created_at numeric
		)
	`)

  // Get current migrations from database
  const rows = await db.all(sql`SELECT id, hash, created_at FROM "__drizzle_migrations" ORDER BY created_at DESC`)

  // Convert the rows to a more usable format
  const dbMigrations = rows.map(([id, hash, created_at]: any) => ({
    id,
    hash,
    created_at,
  }))

  const hasBeenRun = (hash: string) =>
    dbMigrations.find((dbMigration: any) => {
      return dbMigration?.hash === hash
    })

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

/**
 * Initialize tables as CRRs (Conflict-free Replicated Relations) for cr-sqlite sync.
 * This should be called after migrations when using cr-sqlite.
 *
 * @param db - The database instance
 * @returns A promise that resolves when CRR initialization is complete
 */
export async function initializeCRRs(db: AnyDrizzleDatabase): Promise<void> {
  const startTime = performance.now()
  let tablesInitialized = 0

  for (const tableName of CRR_TABLES) {
    try {
      // Check if table exists before trying to make it a CRR
      const tableExists = await db.all(
        sql.raw(`SELECT name FROM sqlite_master WHERE type='table' AND name='${tableName}'`),
      )

      if (tableExists.length > 0) {
        // crsql_as_crr is idempotent - safe to call multiple times
        await db.run(sql.raw(`SELECT crsql_as_crr('${tableName}')`))
        tablesInitialized++
      }
    } catch (error) {
      // If cr-sqlite is not loaded, this will fail - that's expected for non-crsqlite databases
      const errorMsg = error instanceof Error ? error.message : String(error)
      if (errorMsg.includes('no such function: crsql_as_crr')) {
        console.warn('CRR initialization skipped - cr-sqlite extension not loaded')
        return
      }
      console.error(`Failed to initialize CRR for table ${tableName}:`, error)
      throw error
    }
  }

  const elapsedMs = Math.round(performance.now() - startTime)
  console.info(`Initialized ${tablesInitialized} table${tablesInitialized === 1 ? '' : 's'} as CRRs in ${elapsedMs} ms`)
}
