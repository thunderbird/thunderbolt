import { getSetting, updateSetting } from '@/lib/dal'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

/**
 * Custom hook for managing settings with React Query
 * @param key The setting key
 * @param defaultValue The default value if setting doesn't exist
 * @returns [value, setter] tuple similar to useState
 *
 * @example
 * ```tsx
 * const [cloudUrl, setCloudUrl] = useSetting('cloud_url', 'https://default.com')
 *
 * // Use the value
 * console.log(cloudUrl) // current value or default
 *
 * // Update the value
 * setCloudUrl('https://new-url.com')
 * ```
 */
export const useSetting = (key: string, defaultValue: string | null = null) => {
  const queryClient = useQueryClient()

  const { data: value = defaultValue } = useQuery({
    queryKey: ['setting', key],
    queryFn: () => getSetting(key, defaultValue),
  })

  const mutation = useMutation({
    mutationFn: (newValue: string) => updateSetting(key, newValue),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['setting', key] })
    },
  })

  const setValue = (newValue: string) => {
    mutation.mutate(newValue)
  }

  return [value, setValue] as const
}

/**
 * Custom hook for managing boolean settings with React Query
 * @param key The setting key
 * @param defaultValue The default boolean value if setting doesn't exist
 * @returns [value, setter] tuple with boolean value and boolean setter
 *
 * @example
 * ```tsx
 * const [triggersEnabled, setTriggersEnabled] = useBooleanSetting('triggers_is_enabled', false)
 *
 * // Use the value
 * if (triggersEnabled) {
 *   // Do something when enabled
 * }
 *
 * // Update the value
 * setTriggersEnabled(true)
 * ```
 */
export const useBooleanSetting = (key: string, defaultValue: boolean = false) => {
  const queryClient = useQueryClient()

  const { data: value = defaultValue } = useQuery({
    queryKey: ['setting', key],
    queryFn: async (): Promise<boolean> => {
      const setting = await getSetting(key, defaultValue.toString())
      return setting === 'true'
    },
  })

  const mutation = useMutation({
    mutationFn: (newValue: boolean) => updateSetting(key, newValue.toString()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['setting', key] })
    },
  })

  const setValue = (newValue: boolean) => {
    mutation.mutate(newValue)
  }

  return [value, setValue] as const
}
