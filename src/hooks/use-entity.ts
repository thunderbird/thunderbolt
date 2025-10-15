import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'

/**
 * Configuration for the generic entity hook
 */
export type EntityConfig<T> = {
  /** Unique query key for React Query */
  queryKey: unknown[]

  /** Function to fetch the entity from the database */
  queryFn: () => Promise<T | null>

  /** Function to update the entity */
  updateFn: (updates: Partial<T>) => Promise<void>

  /** Function to reset the entity to its default */
  resetFn: () => Promise<void>

  /** Function to check if the entity has been modified from its default */
  isModifiedFn: (data: T | null) => boolean
}

/**
 * Return type for the entity hook
 */
export type UseEntityResult<T> = {
  /** The entity data */
  data: T | null

  /** Whether the entity has been modified from its default */
  isModified: boolean

  /** Update the entity with partial data */
  update: (updates: Partial<T>) => Promise<void>

  /** Reset the entity to its default */
  reset: () => Promise<void>

  /** Whether the query is loading */
  isLoading: boolean

  /** Whether an update or reset mutation is in progress */
  isSaving: boolean

  /** The underlying query object for advanced use */
  query: ReturnType<typeof useQuery<T | null>>
}

/**
 * Generic hook for managing entities with defaults and modification tracking
 *
 * This hook provides a unified interface for working with any entity that:
 * - Has a default value
 * - Can be modified from its default
 * - Can be reset to its default
 * - Uses hash-based modification tracking
 *
 * @example
 * ```tsx
 * const model = useEntity({
 *   queryKey: ['models', modelId],
 *   queryFn: () => getModel(modelId),
 *   updateFn: (updates) => updateModel(modelId, updates),
 *   resetFn: () => resetModelToDefault(modelId, defaultModel),
 *   isModifiedFn: (data) => isModelModified(data),
 * })
 *
 * // Use the entity
 * console.log(model.data)
 * console.log(model.isModified)
 *
 * // Update the entity
 * model.update({ name: 'New Name' })
 *
 * // Reset to default
 * model.reset()
 * ```
 */
export const useEntity = <T>(config: EntityConfig<T>): UseEntityResult<T> => {
  const queryClient = useQueryClient()
  const { queryKey, queryFn, updateFn, resetFn, isModifiedFn } = config

  // Fetch the entity
  const query = useQuery({
    queryKey,
    queryFn,
  })

  // Check if modified using the provided function
  const isModified = useMemo(() => isModifiedFn(query.data ?? null), [query.data, isModifiedFn])

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: updateFn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
    },
  })

  // Reset mutation
  const resetMutation = useMutation({
    mutationFn: resetFn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
    },
  })

  const update = async (updates: Partial<T>) => {
    await updateMutation.mutateAsync(updates)
  }

  const reset = async () => {
    await resetMutation.mutateAsync()
  }

  const isSaving = updateMutation.isPending || resetMutation.isPending

  return {
    data: query.data ?? null,
    isModified,
    update,
    reset,
    isLoading: query.isLoading,
    isSaving,
    query,
  }
}
