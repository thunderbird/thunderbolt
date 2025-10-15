import { getAllPrompts, resetAutomationToDefault, updateAutomation } from '@/lib/dal'
import { defaultAutomations } from '@/lib/defaults/automations'
import { isAutomationModified } from '@/lib/defaults/utils'
import type { Prompt } from '@/types'
import { useEntities, type UseEntitiesResult } from './use-entities-plural'

/**
 * Hook for managing multiple automations/prompts with modification tracking and reset capability
 *
 * @param searchQuery - Optional search query to filter automations
 *
 * @example
 * ```tsx
 * const automations = useAutomations()
 *
 * return (
 *   <>
 *     {automations.data.map((automation) => (
 *       <div key={automation.id}>
 *         <Input
 *           value={automation.title ?? ''}
 *           onChange={(e) => automations.update(automation.id, { title: e.target.value })}
 *         />
 *         <Textarea
 *           value={automation.prompt}
 *           onChange={(e) => automations.update(automation.id, { prompt: e.target.value })}
 *         />
 *         {automations.isModified(automation.id) && (
 *           <Button onClick={() => automations.reset(automation.id)}>Reset to Default</Button>
 *         )}
 *       </div>
 *     ))}
 *   </>
 * )
 * ```
 */
export const useAutomations = (searchQuery?: string): UseEntitiesResult<Prompt> => {
  return useEntities<Prompt>({
    queryKey: ['prompts', searchQuery],
    queryFn: () => getAllPrompts(searchQuery),
    updateFn: updateAutomation,
    resetFn: async (id: string) => {
      const defaultAutomation = defaultAutomations.find((a) => a.id === id)
      if (!defaultAutomation) {
        throw new Error(`No default automation found for id: ${id}`)
      }
      await resetAutomationToDefault(id, defaultAutomation)
    },
    isModifiedFn: isAutomationModified,
    getIdFn: (automation) => automation.id,
  })
}
