import { getRawSettings, resetSettingToDefault, updateSetting } from '@/lib/dal'
import { defaultSettings } from '@/lib/defaults/settings'
import { isSettingModified } from '@/lib/defaults/utils'
import { camelCased } from '@/lib/utils'
import type { Setting } from '@/types'
import { useMemo } from 'react'
import { useEntities } from './use-entities-plural'

/**
 * Interface for a single setting within the useSettings result
 */
export type SettingHook = {
  /** The setting's value */
  value: string | null
  /** Update the setting's value */
  setValue: (value: string | null) => Promise<void>
  /** Whether the setting has been modified from its default */
  isModified: boolean
  /** Reset the setting to its default */
  reset: () => Promise<void>
  /** The raw setting object with metadata */
  rawSetting: Setting | null
  /** Whether an update or reset is in progress for this setting */
  isSaving: boolean
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
  const entities = useEntities<Setting>({
    queryKey: ['settings', ...keys],
    queryFn: async () => {
      const result = await getRawSettings([...keys])
      return Object.values(result)
    },
    updateFn: async (key: string, updates: Partial<Setting>) => {
      if ('value' in updates) {
        await updateSetting(key, updates.value ?? null)
      }
    },
    resetFn: async (key: string) => {
      const defaultSetting = defaultSettings.find((s) => s.key === key)
      if (!defaultSetting) {
        throw new Error(`No default setting found for key: ${key}`)
      }
      await resetSettingToDefault(key, defaultSetting)
    },
    isModifiedFn: isSettingModified,
    getIdFn: (setting) => setting.key,
  })

  const { camelCase = true } = options

  // Transform the entities result into a clean destructurable object
  return useMemo(() => {
    const result = {} as Record<string, SettingHook>

    for (const key of keys) {
      const setting = entities.byId[key]
      const resultKey = camelCase ? camelCased(key) : key

      result[resultKey] = {
        value: setting?.value ?? null,
        setValue: async (value: string | null) => {
          await entities.update(key, { value })
        },
        isModified: entities.isModified(key),
        reset: async () => {
          await entities.reset(key)
        },
        rawSetting: setting ?? null,
        isSaving: entities.isSaving,
      }
    }

    return result as UseSettingsResult<T, typeof camelCase extends true ? true : false>
  }, [entities, keys, camelCase])
}

/**
 * Interface for a single boolean setting within the useBooleanSettings result
 */
export type BooleanSettingHook = {
  /** The boolean value */
  value: boolean
  /** Update the boolean value */
  setValue: (value: boolean) => Promise<void>
  /** Whether the setting has been modified from its default */
  isModified: boolean
  /** Reset the setting to its default */
  reset: () => Promise<void>
  /** The raw setting object with metadata */
  rawSetting: Setting | null
  /** Whether an update or reset is in progress for this setting */
  isSaving: boolean
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
  // Call useSettings with the same camelCase option (or default to true)
  const camelCase = options?.camelCase ?? true
  const settings = camelCase ? useSettings(keys, { camelCase: true }) : useSettings(keys, { camelCase: false })

  return useMemo(() => {
    const result = {} as Record<string, BooleanSettingHook>

    for (const key of keys) {
      const resultKey = camelCase ? camelCased(key) : key
      // Access the setting by the same key transformation used in settings
      const setting = (settings as Record<string, SettingHook>)[resultKey]

      result[resultKey] = {
        value: setting.value === 'true',
        setValue: async (value: boolean) => {
          // Delegate to the underlying setting's setValue which handles the mutation
          await setting.setValue(value ? 'true' : 'false')
        },
        isModified: setting.isModified,
        reset: setting.reset,
        rawSetting: setting.rawSetting,
        isSaving: setting.isSaving,
      }
    }

    return result as UseBooleanSettingsResult<T, typeof camelCase extends true ? true : false>
  }, [settings, keys, camelCase])
}
