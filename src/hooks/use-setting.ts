import { getRawSettings, resetSettingToDefault, updateBooleanSetting, updateSetting } from '@/lib/dal'
import { defaultSettings } from '@/lib/defaults/settings'
import { isSettingModified } from '@/lib/defaults/utils'
import type { Setting } from '@/types'
import { useEntity, type UseEntityResult } from './use-entity'

/**
 * Extended result type for settings that includes the raw setting data
 */
export type UseSettingResult = UseEntityResult<Setting> & {
  /** The raw setting object with metadata */
  rawSetting: Setting | null

  /** The setting's value (convenience accessor) */
  value: string | null

  /** Update just the value (convenience method) */
  setValue: (value: string | null) => Promise<void>
}

/**
 * Hook for managing a string setting with modification tracking and reset capability
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
  const defaultSetting = defaultSettings.find((s) => s.key === key)

  const entity = useEntity<Setting>({
    queryKey: ['settings', key],
    queryFn: async () => {
      const result = await getRawSettings([key])
      return result[key] ?? null
    },
    updateFn: async (updates) => {
      if ('value' in updates) {
        await updateSetting(key, updates.value ?? null)
      }
    },
    resetFn: async () => {
      if (!defaultSetting) {
        throw new Error(`No default setting found for key: ${key}`)
      }
      await resetSettingToDefault(key, defaultSetting)
    },
    isModifiedFn: (data) => isSettingModified(data ?? undefined),
  })

  const value = entity.data?.value ?? defaultValue

  const setValue = async (newValue: string | null) => {
    await entity.update({ value: newValue } as Partial<Setting>)
  }

  return {
    ...entity,
    rawSetting: entity.data,
    value,
    setValue,
  }
}

/**
 * Extended result type for boolean settings
 */
export type UseBooleanSettingResult = UseEntityResult<Setting> & {
  /** The raw setting object with metadata */
  rawSetting: Setting | null

  /** The boolean value (convenience accessor) */
  value: boolean

  /** Update just the value (convenience method) */
  setValue: (value: boolean) => Promise<void>
}

/**
 * Hook for managing a boolean setting with modification tracking and reset capability
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
  const defaultSetting = defaultSettings.find((s) => s.key === key)

  const entity = useEntity<Setting>({
    queryKey: ['settings', key],
    queryFn: async () => {
      const result = await getRawSettings([key])
      return result[key] ?? null
    },
    updateFn: async (updates) => {
      if ('value' in updates) {
        const boolValue = updates.value === 'true'
        await updateBooleanSetting(key, boolValue)
      }
    },
    resetFn: async () => {
      if (!defaultSetting) {
        throw new Error(`No default setting found for key: ${key}`)
      }
      await resetSettingToDefault(key, defaultSetting)
    },
    isModifiedFn: (data) => isSettingModified(data ?? undefined),
  })

  const value = entity.data?.value === 'true' || (entity.data === null && defaultValue)

  const setValue = async (newValue: boolean) => {
    await entity.update({ value: newValue ? 'true' : 'false' } as Partial<Setting>)
  }

  return {
    ...entity,
    rawSetting: entity.data,
    value,
    setValue,
  }
}
