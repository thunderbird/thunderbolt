import { getFeatureFlag, updateFeatureFlag } from '@/lib/dal'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query'

/**
 * Custom hook for managing feature flags with React Query
 * @param key The feature flag key
 * @param defaultValue The default boolean value if feature flag doesn't exist
 * @returns [value, setter, query, mutation] tuple with boolean value (or undefined), boolean setter, and query/mutation objects
 *
 * @example
 * ```tsx
 * const [isTasksEnabled, setIsTasksEnabled, query, mutation] = useFeatureFlag('tasks')
 *
 * // Use the value (handle undefined case)
 * if (isTasksEnabled === true) {
 *   // Do something when enabled
 * }
 *
 * // Update the value
 * setIsTasksEnabled(true)
 *
 * // Check loading state
 * if (query.isLoading) {
 *   // Handle loading
 * }
 * ```
 */
export const useFeatureFlag = (
  key: string,
  defaultValue?: boolean,
): [
  boolean | undefined,
  (newValue: boolean) => void,
  UseQueryResult<boolean | undefined, Error>,
  UseMutationResult<void, Error, boolean, unknown>,
] => {
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ['feature_flags', key],
    queryFn: () => getFeatureFlag(key, defaultValue),
  })

  const mutation = useMutation({
    mutationFn: (newValue: boolean) => updateFeatureFlag(key, newValue),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feature_flags', key] })
    },
  })

  const setValue = (newValue: boolean) => {
    mutation.mutate(newValue)
  }

  const value = query.data ?? defaultValue

  return [value, setValue, query, mutation]
}

/**
 * Alias for useFeatureFlag for consistency with existing useBooleanSetting naming
 */
export const useBooleanFeatureFlag = useFeatureFlag
