import { getAllModels, resetModelToDefault, updateModel } from '@/lib/dal'
import { defaultModels } from '@/lib/defaults/models'
import { isModelModified } from '@/lib/defaults/utils'
import type { Model } from '@/types'
import { useEntities, type UseEntitiesResult } from './use-entities-plural'

/**
 * Hook for managing multiple models with modification tracking and reset capability
 *
 * @example
 * ```tsx
 * const models = useModels()
 *
 * return (
 *   <>
 *     {models.data.map((model) => (
 *       <div key={model.id}>
 *         <Input
 *           value={model.name}
 *           onChange={(e) => models.update(model.id, { name: e.target.value })}
 *         />
 *         {models.isModified(model.id) && (
 *           <Button onClick={() => models.reset(model.id)}>Reset to Default</Button>
 *         )}
 *       </div>
 *     ))}
 *   </>
 * )
 * ```
 */
export const useModels = (): UseEntitiesResult<Model> => {
  return useEntities<Model>({
    queryKey: ['models'],
    queryFn: getAllModels,
    updateFn: updateModel,
    resetFn: async (id: string) => {
      const defaultModel = defaultModels.find((m) => m.id === id)
      if (!defaultModel) {
        throw new Error(`No default model found for id: ${id}`)
      }
      await resetModelToDefault(id, defaultModel)
    },
    isModifiedFn: isModelModified,
    getIdFn: (model) => model.id,
  })
}
