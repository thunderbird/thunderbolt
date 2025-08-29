import { getBooleanSetting, getSetting, updateSetting } from '@/lib/dal'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query'

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
export const useSetting = <T = string>(
  key: string,
  defaultValue: T | null = null,
): [
  T | null,
  (newValue: T | null) => void,
  UseQueryResult<T | null, Error>,
  UseMutationResult<void, Error, T | null, unknown>,
] => {
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ['settings', key],
    queryFn: () => getSetting(key, defaultValue),
  })

  const mutation = useMutation({
    mutationFn: (newValue: T | null) => updateSetting(key, newValue ? newValue.toString() : null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings', key] })
    },
  })

  const setValue = (newValue: T | null) => {
    mutation.mutate(newValue)
  }

  const value = query.data ?? defaultValue

  return [value, setValue, query, mutation]
}

/**
 * Custom hook for managing boolean settings with React Query
 * @param key The setting key
 * @param defaultValue The default boolean value if setting doesn't exist
 * @returns [value, setter, query, mutation] tuple with boolean value, boolean setter, and query/mutation objects
 *
 * @example
 * ```tsx
 * const [triggersEnabled, setTriggersEnabled, query, mutation] = useBooleanSetting('is_triggers_enabled', false)
 *
 * // Use the value
 * if (triggersEnabled) {
 *   // Do something when enabled
 * }
 *
 * // Update the value
 * setTriggersEnabled(true)
 *
 * // Check loading state
 * if (query.isLoading) {
 *   // Handle loading
 * }
 * ```
 */
export const useBooleanSetting = (
  key: string,
  defaultValue: boolean = false,
): [
  boolean,
  (newValue: boolean) => void,
  UseQueryResult<boolean, Error>,
  UseMutationResult<void, Error, boolean, unknown>,
] => {
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ['settings', key],
    queryFn: () => getBooleanSetting(key, defaultValue),
  })

  const mutation = useMutation({
    mutationFn: (newValue: boolean) => updateSetting(key, newValue.toString()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings', key] })
    },
  })

  const setValue = (newValue: boolean) => {
    mutation.mutate(newValue)
  }

  const value = query.data ?? defaultValue

  return [value, setValue, query, mutation]
}
