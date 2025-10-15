import { getModel, resetModelToDefault, updateModel } from '@/lib/dal'
import { defaultModels } from '@/lib/defaults/models'
import { isModelModified } from '@/lib/defaults/utils'
import type { Model } from '@/types'
import { useEntity, type UseEntityResult } from './use-entity'

/**
 * Hook for managing a model with modification tracking and reset capability
 *
 * @param id - The model ID
 *
 * @example
 * ```tsx
 * const model = useModel(modelId)
 *
 * return (
 *   <>
 *     <Input
 *       value={model.data?.name ?? ''}
 *       onChange={(e) => model.update({ name: e.target.value })}
 *     />
 *     {model.isModified && (
 *       <Button onClick={model.reset}>Reset to Default</Button>
 *     )}
 *   </>
 * )
 * ```
 */
export const useModel = (id: string): UseEntityResult<Model> => {
  const defaultModel = defaultModels.find((m) => m.id === id)

  return useEntity<Model>({
    queryKey: ['models', id],
    queryFn: () => getModel(id),
    updateFn: (updates) => updateModel(id, updates),
    resetFn: async () => {
      if (!defaultModel) {
        throw new Error(`No default model found for id: ${id}`)
      }
      await resetModelToDefault(id, defaultModel)
    },
    isModifiedFn: (data) => (data ? isModelModified(data) : false),
  })
}
