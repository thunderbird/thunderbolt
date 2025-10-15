import { getRawSettings, resetSettingToDefault, updateSetting } from '@/lib/dal'
import { defaultSettings } from '@/lib/defaults/settings'
import { isSettingModified } from '@/lib/defaults/utils'
import { camelCased } from '@/lib/utils'
import type { Setting } from '@/types'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'

/**
 * Interface for a single setting within the useSettings result
 * Supports both string and boolean values based on the schema
 */
export type SettingHook = {
  /** The raw setting object with metadata */
  data: Setting | null
  /** The raw setting object with metadata (alias for consistency) */
  rawSetting: Setting | null
  /** The setting's value (string, null, or boolean) */
  value: string | null | boolean
  /** Whether the setting has been modified from its default */
  isModified: boolean
  /** Update the setting's value */
  setValue: (value: string | null | boolean) => Promise<void>
  /** Reset the setting to its default */
  reset: () => Promise<void>
  /** Whether the query is loading */
  isLoading: boolean
  /** Whether an update or reset is in progress for this setting */
  isSaving: boolean
  /** The underlying query object for advanced use */
  query: ReturnType<typeof useQuery<Setting[]>>
}

/**
 * Helper type to convert snake_case to camelCase
 */
type CamelCaseKey<S extends string> = S extends `${infer P1}_${infer P2}` ? `${P1}${Capitalize<CamelCaseKey<P2>>}` : S

/**
 * Type schema for settings - maps keys to their value types
 */
type SettingSchema = Record<string, StringConstructor | BooleanConstructor>

/**
 * Extract the hook type based on the constructor type
 */
type HookForType<T> = T extends BooleanConstructor ? SettingHook : T extends StringConstructor ? SettingHook : never

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
 * Result type for useSettings - returns an object with each setting as a property
 */
export type UseSettingsResult<T extends readonly string[], CamelCase extends boolean = true> = CamelCase extends true
  ? {
      [K in T[number] as K extends string ? CamelCaseKey<K> : K]: SettingHook
    }
  : {
      [K in T[number]]: SettingHook
    }

/**
 * Hook for managing multiple settings with modification tracking and reset capability
 *
 * Returns an object where each key is a setting, allowing clean destructuring.
 * All settings are fetched in a single efficient query.
 *
 * @param keys - Array of setting keys to fetch, or an object schema mapping keys to types
 * @param options - Optional configuration
 * @param options.camelCase - If true (default), converts snake_case keys to camelCase in the result
 *
 * @example
 * ```tsx
 * // With type schema (automatically handles strings and booleans)
 * const { cloudUrl, dataCollection, experimentalFeatureTasks } = useSettings({
 *   cloud_url: String,
 *   data_collection: Boolean,
 *   experimental_feature_tasks: Boolean,
 * })
 *
 * // With camelCase conversion (default)
 * const { cloudUrl, dataCollection, preferredName } = useSettings([
 *   'cloud_url',
 *   'data_collection',
 *   'preferred_name'
 * ] as const)
 *
 * // With snake_case keys (opt-out)
 * const { cloud_url, data_collection, preferred_name } = useSettings([
 *   'cloud_url',
 *   'data_collection',
 *   'preferred_name'
 * ] as const, { camelCase: false })
 *
 * return (
 *   <>
 *     <Input
 *       value={cloudUrl.value ?? ''}
 *       onChange={(e) => cloudUrl.setValue(e.target.value)}
 *     />
 *     {cloudUrl.isModified && (
 *       <Button onClick={cloudUrl.reset}>Reset</Button>
 *     )}
 *   </>
 * )
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
export function useSettings<T extends readonly string[]>(keys: T): UseSettingsResult<T, true>
export function useSettings<T extends readonly string[]>(
  keys: T,
  options: { camelCase: true },
): UseSettingsResult<T, true>
export function useSettings<T extends readonly string[]>(
  keys: T,
  options: { camelCase: false },
): UseSettingsResult<T, false>
export function useSettings<T extends readonly string[] | SettingSchema>(
  keysOrSchema: T,
  options: { camelCase?: boolean } = {},
):
  | UseSettingsResult<T extends readonly string[] ? T : never, boolean>
  | UseSettingsSchemaResult<T extends SettingSchema ? T : never, boolean> {
  const queryClient = useQueryClient()
  const { camelCase = true } = options

  // Check if we received a schema object or an array
  const isSchema = !Array.isArray(keysOrSchema)
  const keys = isSchema ? Object.keys(keysOrSchema) : keysOrSchema
  const schema = isSchema ? (keysOrSchema as SettingSchema) : null

  const query = useQuery({
    queryKey: ['settings', ...keys],
    queryFn: async () => {
      const result = await getRawSettings([...keys])
      return Object.values(result)
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string | null | boolean }) => updateSetting(key, value),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings', ...keys] })
    },
  })

  const resetMutation = useMutation({
    mutationFn: async (key: string) => {
      const defaultSetting = defaultSettings.find((s) => s.key === key)
      if (!defaultSetting) {
        throw new Error(`No default setting found for key: ${key}`)
      }
      await resetSettingToDefault(key, defaultSetting)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings', ...keys] })
    },
  })

  // Create lookup by key
  const byKey = useMemo(() => {
    if (!query.data) return {}
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
    const result = {} as Record<string, SettingHook>

    for (const key of keys) {
      const setting = byKey[key]
      const resultKey = camelCase ? camelCased(key) : key
      const isBoolean = schema ? schema[key] === Boolean : false
      const value = isBoolean ? setting?.value === 'true' : (setting?.value ?? null)

      result[resultKey] = {
        data: setting ?? null,
        rawSetting: setting ?? null,
        value,
        isModified: isSettingModified(setting),
        setValue: async (value: string | null | boolean) => {
          await updateMutation.mutateAsync({ key, value })
        },
        reset: async () => {
          await resetMutation.mutateAsync(key)
        },
        isLoading,
        isSaving,
        query,
      }
    }

    return result as any
  }, [byKey, keys, camelCase, schema, updateMutation, resetMutation, isSaving, isLoading, query])
}
