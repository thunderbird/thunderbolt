import { useBooleanSettings, useSettings, type BooleanSettingHook, type SettingHook } from './use-settings'

/**
 * Result type for a single setting (same as SettingHook)
 */
export type UseSettingResult = SettingHook

/**
 * Hook for managing a single string setting with modification tracking and reset capability
 *
 * This is a convenience wrapper around `useSettings` that handles a single setting.
 *
 * @param key - The setting key
 * @param defaultValue - Default value to use if setting doesn't exist
 *
 * @example
 * ```tsx
 * const preferredName = useSetting('preferred_name', '')
 *
 * return (
 *   <>
 *     <Input
 *       value={preferredName.value ?? ''}
 *       onChange={(e) => preferredName.setValue(e.target.value)}
 *     />
 *     {preferredName.isModified && (
 *       <Button onClick={preferredName.reset}>Reset</Button>
 *     )}
 *   </>
 * )
 * ```
 */
export const useSetting = (key: string, defaultValue: string | null = null): UseSettingResult => {
  const settings = useSettings([key] as const, { camelCase: false })
  const setting = settings[key]

  return {
    ...setting,
    value: setting.value ?? defaultValue,
  }
}

/**
 * Result type for a single boolean setting (same as BooleanSettingHook)
 */
export type UseBooleanSettingResult = BooleanSettingHook

/**
 * Hook for managing a single boolean setting with modification tracking and reset capability
 *
 * This is a convenience wrapper around `useBooleanSettings` that handles a single setting.
 *
 * @param key - The setting key
 * @param defaultValue - Default boolean value to use if setting doesn't exist
 *
 * @example
 * ```tsx
 * const dataCollection = useBooleanSetting('data_collection', true)
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
export const useBooleanSetting = (key: string, defaultValue: boolean = false): UseBooleanSettingResult => {
  const settings = useBooleanSettings([key] as const, { camelCase: false })
  const setting = settings[key]

  return {
    ...setting,
    value: setting.value || (!setting.data && defaultValue),
  }
}
