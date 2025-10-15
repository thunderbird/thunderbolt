import { getRawSettings, resetSettingToDefault, updateBooleanSetting, updateSetting } from '@/lib/dal'
import { defaultSettings } from '@/lib/defaults/settings'
import { isSettingModified } from '@/lib/defaults/utils'
import { camelCased } from '@/lib/utils'
import type { Setting } from '@/types'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'

/**
 * Interface for a single setting within the useSettings result
 */
export type SettingHook = {
  /** The raw setting object with metadata */
  data: Setting | null
  /** The raw setting object with metadata (alias for consistency) */
  rawSetting: Setting | null
  /** The setting's value */
  value: string | null
  /** Whether the setting has been modified from its default */
  isModified: boolean
  /** Update the setting's value */
  setValue: (value: string | null) => Promise<void>
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
 * @param keys - Array of setting keys to fetch
 * @param options - Optional configuration
 * @param options.camelCase - If true (default), converts snake_case keys to camelCase in the result
 *
 * @example
 * ```tsx
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
export function useSettings<T extends readonly string[]>(keys: T): UseSettingsResult<T, true>
export function useSettings<T extends readonly string[]>(
  keys: T,
  options: { camelCase: true },
): UseSettingsResult<T, true>
export function useSettings<T extends readonly string[]>(
  keys: T,
  options: { camelCase: false },
): UseSettingsResult<T, false>
export function useSettings<T extends readonly string[]>(
  keys: T,
  options: { camelCase?: boolean } = {},
): UseSettingsResult<T, boolean> {
  const queryClient = useQueryClient()
  const { camelCase = true } = options

  const query = useQuery({
    queryKey: ['settings', ...keys],
    queryFn: async () => {
      const result = await getRawSettings([...keys])
      return Object.values(result)
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string | null }) => updateSetting(key, value),
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

      result[resultKey] = {
        data: setting ?? null,
        rawSetting: setting ?? null,
        value: setting?.value ?? null,
        isModified: isSettingModified(setting),
        setValue: async (value: string | null) => {
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

    return result as UseSettingsResult<T, typeof camelCase extends true ? true : false>
  }, [byKey, keys, camelCase, updateMutation, resetMutation, isSaving, isLoading, query])
}

/**
 * Interface for a single boolean setting within the useBooleanSettings result
 */
export type BooleanSettingHook = {
  /** The raw setting object with metadata */
  data: Setting | null
  /** The raw setting object with metadata (alias for consistency) */
  rawSetting: Setting | null
  /** The boolean value */
  value: boolean
  /** Whether the setting has been modified from its default */
  isModified: boolean
  /** Update the boolean value */
  setValue: (value: boolean) => Promise<void>
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
 * Result type for useBooleanSettings - returns an object with each boolean setting as a property
 */
export type UseBooleanSettingsResult<
  T extends readonly string[],
  CamelCase extends boolean = true,
> = CamelCase extends true
  ? {
      [K in T[number] as K extends string ? CamelCaseKey<K> : K]: BooleanSettingHook
    }
  : {
      [K in T[number]]: BooleanSettingHook
    }

/**
 * Convenience hook for managing multiple boolean settings
 *
 * Like useSettings but with boolean-specific helpers and proper boolean typing.
 *
 * @param keys - Array of boolean setting keys to fetch
 * @param options - Optional configuration
 * @param options.camelCase - If true (default), converts snake_case keys to camelCase in the result
 *
 * @example
 * ```tsx
 * // With camelCase conversion (default)
 * const { dataCollection, experimentalFeatureTasks } = useBooleanSettings([
 *   'data_collection',
 *   'experimental_feature_tasks'
 * ] as const)
 *
 * // With snake_case keys (opt-out)
 * const { data_collection, experimental_feature_tasks } = useBooleanSettings([
 *   'data_collection',
 *   'experimental_feature_tasks'
 * ] as const, { camelCase: false })
 *
 * return (
 *   <>
 *     <Switch
 *       checked={dataCollection.value}
 *       onCheckedChange={dataCollection.setValue}
 *     />
 *     {dataCollection.isModified && (
 *       <Button onClick={dataCollection.reset}>Reset</Button>
 *     )}
 *   </>
 * )
 * ```
 */
export function useBooleanSettings<T extends readonly string[]>(keys: T): UseBooleanSettingsResult<T, true>
export function useBooleanSettings<T extends readonly string[]>(
  keys: T,
  options: { camelCase: true },
): UseBooleanSettingsResult<T, true>
export function useBooleanSettings<T extends readonly string[]>(
  keys: T,
  options: { camelCase: false },
): UseBooleanSettingsResult<T, false>
export function useBooleanSettings<T extends readonly string[]>(
  keys: T,
  options?: { camelCase?: boolean },
): UseBooleanSettingsResult<T, boolean> {
  const queryClient = useQueryClient()
  const camelCase = options?.camelCase ?? true

  const query = useQuery({
    queryKey: ['settings', ...keys],
    queryFn: async () => {
      const result = await getRawSettings([...keys])
      return Object.values(result)
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ key, value }: { key: string; value: boolean }) => updateBooleanSetting(key, value),
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

  return useMemo(() => {
    const result = {} as Record<string, BooleanSettingHook>

    for (const key of keys) {
      const setting = byKey[key]
      const resultKey = camelCase ? camelCased(key) : key

      result[resultKey] = {
        data: setting ?? null,
        rawSetting: setting ?? null,
        value: setting?.value === 'true',
        isModified: isSettingModified(setting),
        setValue: async (value: boolean) => {
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

    return result as UseBooleanSettingsResult<T, typeof camelCase extends true ? true : false>
  }, [byKey, keys, camelCase, updateMutation, resetMutation, isSaving, isLoading, query])
}
