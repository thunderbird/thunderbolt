/**
 * This module bundles SQL migration files into a TypeScript file for inclusion at build time.
 * It's used by the Vite build process to avoid runtime filesystem access.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

interface Migration {
  hash: string
  name: string
  sql: string
}

/**
 * Sanitizes SQL content to fix common syntax issues
 * @param sql The SQL content to sanitize
 * @returns Sanitized SQL
 */
function sanitizeSql(sql: string): string {
  // Replace trailing commas before closing parenthesis in CREATE TABLE statements
  return sql.replace(/,(\s*)\)/g, '$1)')
}

/**
 * Bundles SQL migration files into a TypeScript file for inclusion at build time.
 * @param options Optional configuration options
 * @returns Number of bundled migrations
 */
export async function bundleMigrations(options?: {
  migrationsDir?: string
  outputFile?: string
  silent?: boolean
}): Promise<number> {
  // Configuration - simplified paths since we're always calling from root
  const MIGRATIONS_DIR = options?.migrationsDir ?? './src/drizzle'
  const OUTPUT_FILE = options?.outputFile ?? './src/drizzle/_migrations.ts'
  const silent = options?.silent ?? false

  // Ensure directories exist
  if (!existsSync(dirname(OUTPUT_FILE))) {
    mkdirSync(dirname(OUTPUT_FILE), { recursive: true })
  }

  // Get all SQL files
  const migrationFiles = readdirSync(MIGRATIONS_DIR)
    .filter((file: string) => file.endsWith('.sql'))
    .sort((a: string, b: string) => {
      // Sort by the first 4 characters of the file name
      const aHash = a.replace('.sql', '').slice(0, 4)
      const bHash = b.replace('.sql', '').slice(0, 4)
      return aHash.localeCompare(bHash)
    })

  // Generate migrations array
  const migrations: Migration[] = migrationFiles.map((file: string) => {
    const filePath = join(MIGRATIONS_DIR, file)
    const hash = file.replace('.sql', '')
    const sql = readFileSync(filePath, 'utf8')

    return {
      hash,
      name: file,
      sql: sanitizeSql(sql.trim()),
    }
  })

  // Generate TypeScript file content
  const fileContent = `/**
 * This file is auto-generated. Do not edit directly.
 */

export interface Migration {
  hash: string;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  ${migrations
    .map((migration) => {
      // Use JSON.stringify for the SQL content to ensure proper escaping
      return `{
    "hash": ${JSON.stringify(migration.hash)},
    "name": ${JSON.stringify(migration.name)},
    "sql": ${JSON.stringify(migration.sql)}
  }`
    })
    .join(',\n  ')}
];
`

  // Write the output file
  writeFileSync(OUTPUT_FILE, fileContent)

  if (!silent) {
    console.log(`Generated ${OUTPUT_FILE} with ${migrations.length} migrations`)
  }

  return migrations.length
}
