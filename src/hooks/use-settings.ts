/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useDatabase } from '@/contexts'
import { defaultSettings } from '@/defaults/settings'
import { isSettingModified } from '@/defaults/utils'
import { getSettingsRecords, resetSettingToDefault, updateSettings } from '@/dal'
import { deserializeValue, inferTypeFromSchema } from '@/lib/serialization'
import { camelCased } from '@/lib/utils'
import type { Setting } from '@/types'
import { useMutation } from '@tanstack/react-query'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { useMemo } from 'react'

/**
 * Generic setting hook interface
 */
type SettingHook<TValue, TInput = TValue> = {
  /** The raw setting object with metadata */
  data: Setting | null
  /** The raw setting object with metadata (alias for consistency) */
  rawSetting: Setting | null
  /** The setting's value */
  value: TValue
  /** Whether the setting has been modified from its default */
  isModified: boolean
  /** Update the setting's value (can pass null to clear) */
  setValue: (value: TInput, options?: { recomputeHash?: boolean; updateHashOnly?: boolean }) => Promise<void>
  /** Reset the setting to its default */
  reset: () => Promise<void>
  /** Whether the query is loading */
  isLoading: boolean
  /** Whether an update or reset is in progress for this setting */
  isSaving: boolean
  /** The underlying query object for advanced use */
  query: ReturnType<typeof useQuery<Setting>>
}

/**
 * String setting hook - for String type settings
 */
export type StringSettingHook = SettingHook<string | null, string | null>

/**
 * Boolean setting hook - for Boolean type settings
 */
export type BooleanSettingHook = SettingHook<boolean, boolean>

/**
 * String setting with default - value is never null, but setValue accepts null to clear
 */
export type StringSettingWithDefaultHook = SettingHook<string, string | null>

/**
 * Number setting hook
 */
export type NumberSettingHook = SettingHook<number | null, number | null>

/**
 * Number setting with default - value is never null, but setValue accepts null to clear
 */
export type NumberSettingWithDefaultHook = SettingHook<number, number | null>

/**
 * Helper type to convert snake_case to camelCase
 */
type CamelCaseKey<S extends string> = S extends `${infer P1}_${infer P2}` ? `${P1}${Capitalize<CamelCaseKey<P2>>}` : S

/**
 * Type schema for settings - maps keys to their value types or default values
 */
type SettingSchema = Record<
  string,
  string | number | boolean | null | StringConstructor | BooleanConstructor | NumberConstructor
>

/**
 * Extract the hook type based on the schema value
 * - Constructors → nullable value types
 * - Primitive defaults → non-nullable value types (setValue still accepts null to clear)
 */
type HookForType<T> = T extends StringConstructor
  ? StringSettingHook
  : T extends BooleanConstructor
    ? BooleanSettingHook
    : T extends NumberConstructor
      ? NumberSettingHook
      : T extends true | false
        ? BooleanSettingHook
        : T extends boolean
          ? BooleanSettingHook
          : T extends number
            ? NumberSettingWithDefaultHook
            : T extends string
              ? StringSettingWithDefaultHook
              : T extends null
                ? SettingHook<null, null>
                : never

/**
 * Result type for useSettings with schema - returns an object with typed settings
 */
type UseSettingsSchemaResult<T extends SettingSchema, CamelCase extends boolean = true> = CamelCase extends true
  ? {
      [K in keyof T as K extends string ? CamelCaseKey<K> : K]: HookForType<T[K]>
    }
  : {
      [K in keyof T]: HookForType<T[K]>
    }

/**
 * Hook for managing multiple settings with modification tracking and reset capability
 *
 * Returns an object where each key is a setting, allowing clean destructuring.
 * All settings are fetched in a single efficient query.
 *
 * @param schema - Object mapping setting keys to either:
 *   - Type constructors (String, Boolean, Number) for settings without defaults
 *   - Primitive values (strings, numbers, booleans, null) as default values
 * @param options - Optional configuration
 * @param options.camelCase - If true (default), converts snake_case keys to camelCase in the result
 *
 * @example
 * ```tsx
 * // With type constructors (no defaults)
 * const { cloudUrl, dataCollection } = useSettings({
 *   cloud_url: String,
 *   data_collection: Boolean,
 * })
 * // cloudUrl.value = string | null
 * // dataCollection.value = boolean (false if not set)
 *
 * // With default values (infers type from value)
 * const { maxRetries, apiUrl, isEnabled } = useSettings({
 *   max_retries: 3,
 *   api_url: 'https://api.example.com',
 *   is_enabled: true,
 * })
 * // maxRetries.value = number (defaults to 3)
 * // apiUrl.value = string (defaults to 'https://api.example.com')
 * // isEnabled.value = boolean (defaults to true)
 *
 * // Mixed usage
 * const { theme, debugMode } = useSettings({
 *   theme: String,        // No default
 *   debug_mode: false,    // Defaults to false
 * })
 * ```
 */
export function useSettings<T extends SettingSchema>(schema: T): UseSettingsSchemaResult<T, true>
export function useSettings<T extends SettingSchema>(
  schema: T,
  options: { camelCase: true },
): UseSettingsSchemaResult<T, true>
export function useSettings<T extends SettingSchema>(
  schema: T,
  options: { camelCase: false },
): UseSettingsSchemaResult<T, false>
export function useSettings<T extends SettingSchema>(
  schema: T,
  options: { camelCase?: boolean } = {},
): UseSettingsSchemaResult<T, boolean> {
  const db = useDatabase()
  const { camelCase = true } = options

  const keys = Object.keys(schema)

  const query = useQuery({
    queryKey: ['settings', ...keys],
    query: toCompilableQuery(getSettingsRecords(db, keys)),
    placeholderData: (previousData) => previousData,
  })

  const updateMutation = useMutation({
    mutationFn: ({
      key,
      value,
      options,
    }: {
      key: string
      value: string | number | boolean | null
      options?: { recomputeHash?: boolean; updateHashOnly?: boolean }
    }) => updateSettings(db, { [key]: value }, options),
  })

  const resetMutation = useMutation({
    mutationFn: async (key: string) => {
      const defaultSetting = defaultSettings.find((s) => s.key === key)
      if (!defaultSetting) {
        throw new Error(`No default setting found for key: ${key}`)
      }
      await resetSettingToDefault(db, key, defaultSetting)
    },
  })

  // Create lookup by key
  const byKey = useMemo(() => {
    if (!query.data) {
      return {}
    }
    return query.data.reduce(
      (acc, setting) => {
        acc[setting.key] = setting
        return acc
      },
      {} as Record<string, Setting>,
    )
  }, [query.data])

  const isSaving = updateMutation.isPending || resetMutation.isPending
  const isLoading = query.isLoading

  // Transform into a clean destructurable object
  return useMemo(() => {
    const result = {} as Record<
      string,
      | StringSettingHook
      | BooleanSettingHook
      | NumberSettingHook
      | StringSettingWithDefaultHook
      | NumberSettingWithDefaultHook
    >

    for (const key of keys) {
      const setting = byKey[key]
      const resultKey = camelCase ? camelCased(key) : key
      const schemaValue = schema[key]

      // Determine if this is a constructor or a default value
      const isConstructor = typeof schemaValue === 'function'
      const defaultValue = isConstructor ? (schemaValue === Boolean ? false : null) : schemaValue

      // Infer the type hint from the schema value
      const typeHint = inferTypeFromSchema(schemaValue)

      // Deserialize the stored value with type hint for accurate parsing
      const deserializedValue = deserializeValue(setting?.value, typeHint)

      // Apply default if value is null/undefined
      // For Boolean settings with false default, this guarantees value is never null
      const value = (deserializedValue ?? defaultValue) as string | number | boolean | null

      result[resultKey] = {
        data: setting ?? null,
        rawSetting: setting ?? null,
        value,
        isModified: isSettingModified(setting),
        setValue: async (
          value: string | number | boolean | null,
          options?: { recomputeHash?: boolean; updateHashOnly?: boolean },
        ) => {
          await updateMutation.mutateAsync({ key, value, options })
        },
        reset: async () => {
          await resetMutation.mutateAsync(key)
        },
        isLoading,
        isSaving,
        query,
      }
    }

    // Type assertion is safe here because:
    // 1. Boolean settings always have false as default, so value is never null
    // 2. The schema type system enforces correct types for each key
    // 3. deserializeValue + defaultValue ensures proper typing at runtime
    return result as UseSettingsSchemaResult<T, typeof camelCase>
  }, [byKey, keys, camelCase, schema, updateMutation, resetMutation, isSaving, isLoading, query])
}
