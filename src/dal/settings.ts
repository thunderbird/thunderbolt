/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { eq, inArray, sql } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { isInsertConflictError } from '../lib/sqlite-errors'
import { settingsTable } from '../db/tables'
import { hashSetting } from '../defaults/settings'
import { serializeValue } from '../lib/serialization'
import { camelCased, hashValues } from '../lib/utils'
import type { DrizzleQueryWithPromise, Setting } from '@/types'

/**
 * Gets all settings from the database
 */
export const getAllSettings = async (db: AnyDrizzleDatabase): Promise<Setting[]> => {
  return await db.select().from(settingsTable)
}

/**
 * Type schema for settings - maps keys to their value types or default values
 */
type SettingSchema = Record<
  string,
  string | number | boolean | null | StringConstructor | BooleanConstructor | NumberConstructor
>

/**
 * Returns a Drizzle query for settings by keys.
 * Use with PowerSync's toCompilableQuery, or await the result to execute.
 *
 * When keys is empty, uses sql`1=0` instead of inArray -- inArray(column, [])
 * produces invalid SQL (WHERE col IN ()) in SQLite.
 */
export const getSettingsRecords = (db: AnyDrizzleDatabase, keys: string[]) => {
  const query = db
    .select()
    .from(settingsTable)
    .where(keys.length > 0 ? inArray(settingsTable.key, keys) : sql`1=0`)
  return query as typeof query & DrizzleQueryWithPromise<Setting>
}

/**
 * Helper type to convert snake_case to camelCase
 */
type CamelCaseKey<S extends string> = S extends `${infer P1}_${infer P2}` ? `${P1}${Capitalize<CamelCaseKey<P2>>}` : S

/**
 * Result type that conditionally applies camelCase transformation
 */
type GetSettingsResult<T extends SettingSchema, CamelCase extends boolean> = CamelCase extends true
  ? {
      [K in keyof T as K extends string ? CamelCaseKey<K> : K]: T[K] extends StringConstructor
        ? string | null
        : T[K] extends BooleanConstructor
          ? boolean
          : T[K] extends NumberConstructor
            ? number | null
            : T[K] extends true | false
              ? boolean
              : T[K] extends boolean
                ? boolean
                : T[K] extends number
                  ? number
                  : T[K] extends string
                    ? string
                    : T[K] extends null
                      ? null
                      : never
    }
  : {
      [K in keyof T]: T[K] extends StringConstructor
        ? string | null
        : T[K] extends BooleanConstructor
          ? boolean
          : T[K] extends NumberConstructor
            ? number | null
            : T[K] extends true | false
              ? boolean
              : T[K] extends boolean
                ? boolean
                : T[K] extends number
                  ? number
                  : T[K] extends string
                    ? string
                    : T[K] extends null
                      ? null
                      : never
    }

/**
 * Gets settings values for a schema object
 * Returns only the values (not the full Setting records)
 * Values are properly typed based on the schema
 *
 * @param db - Drizzle database instance
 * @param schema - Object mapping setting keys to either type constructors or default values
 * @param options - Optional configuration
 * @param options.camelCase - If true (default), converts snake_case keys to camelCase in the result
 * @returns Object with key-value pairs for the requested settings
 *
 * @example
 * ```ts
 * // With camelCase (default)
 * const settings = await getSettings(db, {
 *   cloud_url: String,           // Returns as cloudUrl: string | null
 *   max_retries: 3,               // Returns as maxRetries: number (defaults to 3)
 *   is_enabled: true,             // Returns as isEnabled: boolean (defaults to true)
 * })
 * // settings = { cloudUrl: string | null, maxRetries: number, isEnabled: boolean }
 *
 * // Without camelCase
 * const settings = await getSettings(db, {
 *   cloud_url: String,
 *   max_retries: 3,
 * }, { camelCase: false })
 * // settings = { cloud_url: string | null, max_retries: number }
 * ```
 */
export function getSettings<T extends SettingSchema>(
  db: AnyDrizzleDatabase,
  schema: T,
): Promise<GetSettingsResult<T, true>>
export function getSettings<T extends SettingSchema>(
  db: AnyDrizzleDatabase,
  schema: T,
  options: { camelCase: true },
): Promise<GetSettingsResult<T, true>>
export function getSettings<T extends SettingSchema>(
  db: AnyDrizzleDatabase,
  schema: T,
  options: { camelCase: false },
): Promise<GetSettingsResult<T, false>>
export async function getSettings<T extends SettingSchema>(
  db: AnyDrizzleDatabase,
  schema: T,
  options: { camelCase?: boolean } = {},
): Promise<GetSettingsResult<T, boolean>> {
  const { camelCase = true } = options
  const keys = Object.keys(schema)

  const results = await Promise.all(
    keys.map((key) => db.select().from(settingsTable).where(eq(settingsTable.key, key)).get()),
  )

  const result: Record<string, string | number | boolean | null> = {}

  for (const key of keys) {
    const schemaValue = schema[key]
    const setting = results.find((r) => r?.key === key)

    // Determine if this is a constructor or a default value
    const isConstructor = schemaValue === String || schemaValue === Boolean || schemaValue === Number
    const defaultValue = isConstructor ? (schemaValue === Boolean ? false : null) : schemaValue

    // Determine the type hint for deserialization
    const typeHint = isConstructor
      ? schemaValue === String
        ? 'string'
        : schemaValue === Boolean
          ? 'boolean'
          : schemaValue === Number
            ? 'number'
            : 'string'
      : typeof defaultValue === 'boolean'
        ? 'boolean'
        : typeof defaultValue === 'number'
          ? 'number'
          : 'string'

    // Deserialize the value
    const deserializedValue =
      setting?.value !== null && setting?.value !== undefined
        ? typeHint === 'boolean'
          ? setting.value === 'true'
          : typeHint === 'number'
            ? Number(setting.value)
            : setting.value
        : null

    // Apply default if value is null/undefined
    const value = (deserializedValue ?? defaultValue) as string | number | boolean | null

    // Store with camelCase key if requested
    const resultKey = camelCase ? camelCased(key) : key
    result[resultKey] = value
  }

  return result as GetSettingsResult<T, typeof camelCase>
}

/**
 * Gets theme setting with proper typing
 */
export const getThemeSetting = async (
  db: AnyDrizzleDatabase,
  storageKey: string,
  defaultTheme: string,
): Promise<string> => {
  const settings = await getSettings(db, { [storageKey]: defaultTheme })
  const camelKey = camelCased(storageKey)
  return settings[camelKey]
}

/**
 * Check if a setting exists in the settings table
 */
export const hasSetting = async (db: AnyDrizzleDatabase, key: string): Promise<boolean> => {
  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(settingsTable)
    .where(eq(settingsTable.key, key))
    .get()
  return (result?.count ?? 0) > 0
}

/**
 * Create a setting only if it doesn't already exist
 * Does nothing if the setting already exists (preserves existing value)
 * Uses insert-then-catch-conflict to avoid TOCTOU race (PowerSync views don't support ON CONFLICT)
 */
export const createSetting = async (db: AnyDrizzleDatabase, key: string, value: string | null): Promise<void> => {
  try {
    await db.insert(settingsTable).values({ key, value })
  } catch (err) {
    if (!isInsertConflictError(err)) {
      throw err
    }
  }
}

/**
 * Prepare a setting row for batch insert/update
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const prepareSettingRow = (key: string, value: any, recomputeHash: boolean) => {
  const stringValue = serializeValue(value)
  return {
    key,
    value: stringValue,
    ...(recomputeHash && { defaultHash: hashValues([key, stringValue]) }),
  }
}

/**
 * Update or create multiple settings at once in a single database operation
 *
 * @param settings - Object mapping setting keys to values
 * @param options - Optional configuration (applies to all settings)
 * @param options.recomputeHash - If true, updates the defaultHash to match the new value for all settings
 * @param options.updateHashOnly - If true, only updates the defaultHash without changing actual values
 *
 * @example
 * ```ts
 * await updateSettings(db, {
 *   oauth_state: 'abc123',
 *   oauth_provider: 'google',
 *   oauth_verifier: 'xyz789',
 * })
 * ```
 */
export const updateSettings = async (
  db: AnyDrizzleDatabase,
  settings: Record<string, any>, // eslint-disable-line @typescript-eslint/no-explicit-any
  options: { recomputeHash?: boolean; updateHashOnly?: boolean } = {},
): Promise<void> => {
  const entries = Object.entries(settings)
  if (entries.length === 0) {
    return
  }

  // Handle updateHashOnly separately as it requires UPDATE statements
  // Note: SQLite doesn't support batch UPDATE with different values per row,
  // so we use parallel updates within a transaction for atomicity
  if (options.updateHashOnly) {
    await db.transaction(async (tx) => {
      await Promise.all(
        entries.map(([key, value]) => {
          const stringValue = serializeValue(value)
          const newHash = hashValues([key, stringValue])
          return tx.update(settingsTable).set({ defaultHash: newHash }).where(eq(settingsTable.key, key))
        }),
      )
    })
    return
  }

  // Insert-first pattern for PowerSync compatibility.
  // PowerSync uses views which don't support ON CONFLICT, so we can't use upsert.
  // Try insert first, then update on unique constraint violation to avoid race conditions
  // when multiple components call updateSettings simultaneously.
  // Wrapped in a transaction so all-or-nothing: if any row fails, none are committed.
  await db.transaction(async (tx) => {
    for (const [key, value] of entries) {
      const row = prepareSettingRow(key, value, options.recomputeHash ?? false)

      try {
        await tx.insert(settingsTable).values(row)
      } catch (err) {
        if (!isInsertConflictError(err)) {
          throw err
        }
        const updateData = options.recomputeHash
          ? { value: row.value, defaultHash: row.defaultHash }
          : { value: row.value }

        await tx.update(settingsTable).set(updateData).where(eq(settingsTable.key, key))
      }
    }
  })
}

/**
 * Delete a setting from the settings table
 * Useful for removing user overrides so the code default is used
 */
export const deleteSetting = async (db: AnyDrizzleDatabase, key: string): Promise<void> => {
  await db.delete(settingsTable).where(eq(settingsTable.key, key))
}

/**
 * Reset a setting to its default state
 */
export const resetSettingToDefault = async (
  db: AnyDrizzleDatabase,
  key: string,
  defaultSetting: Setting,
): Promise<void> => {
  // Compute the hash for the default setting so it shows as unmodified after reset
  const computedHash = hashSetting(defaultSetting)
  const { defaultHash, ...defaultFields } = defaultSetting
  await db
    .update(settingsTable)
    .set({ ...defaultFields, defaultHash: computedHash })
    .where(eq(settingsTable.key, key))
}
