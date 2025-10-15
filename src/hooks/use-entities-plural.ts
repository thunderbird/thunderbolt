import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'

/**
 * Configuration for the plural entities hook
 */
export type EntitiesConfig<T> = {
  /** Unique query key for React Query */
  queryKey: unknown[]

  /** Function to fetch entities from the database */
  queryFn: () => Promise<T[]>

  /** Function to update a single entity */
  updateFn: (id: string, updates: Partial<T>) => Promise<void>

  /** Function to reset a single entity to its default */
  resetFn: (id: string) => Promise<void>

  /** Function to check if an entity has been modified from its default */
  isModifiedFn: (data: T) => boolean

  /** Function to extract the ID from an entity */
  getIdFn: (data: T) => string
}

/**
 * Return type for the entities hook
 */
export type UseEntitiesResult<T> = {
  /** Array of all entities */
  data: T[]

  /** Lookup object for entities by ID */
  byId: Record<string, T>

  /** Update a single entity with partial data */
  update: (id: string, updates: Partial<T>) => Promise<void>

  /** Update multiple entities at once */
  updateMany: (updates: Array<{ id: string; data: Partial<T> }>) => Promise<void>

  /** Reset a single entity to its default */
  reset: (id: string) => Promise<void>

  /** Check if a specific entity is modified */
  isModified: (id: string) => boolean

  /** Whether the query is loading */
  isLoading: boolean

  /** Whether an update or reset mutation is in progress */
  isSaving: boolean

  /** The underlying query object for advanced use */
  query: ReturnType<typeof useQuery<T[]>>
}

/**
 * Generic hook for managing multiple entities with defaults and modification tracking
 *
 * This hook provides a unified interface for working with multiple entities that:
 * - Have default values
 * - Can be modified from their defaults
 * - Can be reset to their defaults
 * - Use hash-based modification tracking
 *
 * @example
 * ```tsx
 * const models = useEntities({
 *   queryKey: ['models'],
 *   queryFn: () => getAllModels(),
 *   updateFn: (id, updates) => updateModel(id, updates),
 *   resetFn: (id) => resetModelToDefault(id, defaultModel),
 *   isModifiedFn: (data) => isModelModified(data),
 *   getIdFn: (data) => data.id,
 * })
 *
 * // Use the entities
 * console.log(models.data) // Array of all models
 * console.log(models.byId['model-id']) // Get specific model
 * console.log(models.isModified('model-id')) // Check if modified
 *
 * // Update a single entity
 * models.update('model-id', { name: 'New Name' })
 *
 * // Update multiple entities
 * models.updateMany([
 *   { id: 'id1', data: { name: 'Name 1' } },
 *   { id: 'id2', data: { name: 'Name 2' } },
 * ])
 *
 * // Reset to default
 * models.reset('model-id')
 * ```
 */
export const useEntities = <T>(config: EntitiesConfig<T>): UseEntitiesResult<T> => {
  const queryClient = useQueryClient()
  const { queryKey, queryFn, updateFn, resetFn, isModifiedFn, getIdFn } = config

  // Fetch the entities
  const query = useQuery({
    queryKey,
    queryFn,
  })

  // Create lookup by ID
  const byId = useMemo(() => {
    if (!query.data) return {}
    return query.data.reduce(
      (acc, entity) => {
        const id = getIdFn(entity)
        acc[id] = entity
        return acc
      },
      {} as Record<string, T>,
    )
  }, [query.data, getIdFn])

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: Partial<T> }) => updateFn(id, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
    },
  })

  // Update many mutation
  const updateManyMutation = useMutation({
    mutationFn: async (updates: Array<{ id: string; data: Partial<T> }>) => {
      await Promise.all(updates.map(({ id, data }) => updateFn(id, data)))
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
    },
  })

  // Reset mutation
  const resetMutation = useMutation({
    mutationFn: (id: string) => resetFn(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
    },
  })

  const update = async (id: string, updates: Partial<T>) => {
    await updateMutation.mutateAsync({ id, updates })
  }

  const updateMany = async (updates: Array<{ id: string; data: Partial<T> }>) => {
    await updateManyMutation.mutateAsync(updates)
  }

  const reset = async (id: string) => {
    await resetMutation.mutateAsync(id)
  }

  const isModified = (id: string): boolean => {
    const entity = byId[id]
    return entity ? isModifiedFn(entity) : false
  }

  const isSaving = updateMutation.isPending || updateManyMutation.isPending || resetMutation.isPending

  return {
    data: query.data ?? [],
    byId,
    update,
    updateMany,
    reset,
    isModified,
    isLoading: query.isLoading,
    isSaving,
    query,
  }
}
