import { DatabaseSingleton } from '@/db/singleton'
import { tasksTable } from '@/db/tables'
import { resetTaskToDefault, updateTask } from '@/lib/dal'
import { defaultTasks, hashTask } from '@/lib/defaults/tasks'
import type { Task } from '@/types'
import { eq } from 'drizzle-orm'
import { useEntity, type UseEntityResult } from './use-entity'

/**
 * Hook for managing a task with modification tracking and reset capability
 *
 * @param id - The task ID
 *
 * @example
 * ```tsx
 * const task = useTask(taskId)
 *
 * return (
 *   <>
 *     <Input
 *       value={task.data?.item ?? ''}
 *       onChange={(e) => task.update({ item: e.target.value })}
 *     />
 *     <Switch
 *       checked={task.data?.isComplete === 1}
 *       onCheckedChange={(checked) => task.update({ isComplete: checked ? 1 : 0 })}
 *     />
 *     {task.isModified && (
 *       <Button onClick={task.reset}>Reset to Default</Button>
 *     )}
 *   </>
 * )
 * ```
 */
export const useTask = (id: string): UseEntityResult<Task> => {
  const defaultTask = defaultTasks.find((t) => t.id === id)

  return useEntity<Task>({
    queryKey: ['tasks', id],
    queryFn: async () => {
      const db = DatabaseSingleton.instance.db
      const result = await db.select().from(tasksTable).where(eq(tasksTable.id, id)).get()
      return result ?? null
    },
    updateFn: (updates) => updateTask(id, updates),
    resetFn: async () => {
      if (!defaultTask) {
        throw new Error(`No default task found for id: ${id}`)
      }
      await resetTaskToDefault(id, defaultTask)
    },
    isModifiedFn: (data) => {
      if (!data || !data.defaultHash) return false
      const currentHash = hashTask(data)
      return currentHash !== data.defaultHash
    },
  })
}
