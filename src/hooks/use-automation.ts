import { DatabaseSingleton } from '@/db/singleton'
import { promptsTable } from '@/db/tables'
import { resetAutomationToDefault, updateAutomation } from '@/lib/dal'
import { defaultAutomations } from '@/lib/defaults/automations'
import { isAutomationModified } from '@/lib/defaults/utils'
import type { Prompt } from '@/types'
import { eq } from 'drizzle-orm'
import { useEntity, type UseEntityResult } from './use-entity'

/**
 * Hook for managing an automation/prompt with modification tracking and reset capability
 *
 * @param id - The automation/prompt ID
 *
 * @example
 * ```tsx
 * const automation = useAutomation(automationId)
 *
 * return (
 *   <>
 *     <Input
 *       value={automation.data?.title ?? ''}
 *       onChange={(e) => automation.update({ title: e.target.value })}
 *     />
 *     <Textarea
 *       value={automation.data?.prompt ?? ''}
 *       onChange={(e) => automation.update({ prompt: e.target.value })}
 *     />
 *     {automation.isModified && (
 *       <Button onClick={automation.reset}>Reset to Default</Button>
 *     )}
 *   </>
 * )
 * ```
 */
export const useAutomation = (id: string): UseEntityResult<Prompt> => {
  const defaultAutomation = defaultAutomations.find((a) => a.id === id)

  return useEntity<Prompt>({
    queryKey: ['automations', id],
    queryFn: async () => {
      const db = DatabaseSingleton.instance.db
      const result = await db.select().from(promptsTable).where(eq(promptsTable.id, id)).get()
      return result ?? null
    },
    updateFn: (updates) => updateAutomation(id, updates),
    resetFn: async () => {
      if (!defaultAutomation) {
        throw new Error(`No default automation found for id: ${id}`)
      }
      await resetAutomationToDefault(id, defaultAutomation)
    },
    isModifiedFn: (data) => (data ? isAutomationModified(data) : false),
  })
}
