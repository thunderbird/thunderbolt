import { getIncompleteTasks, resetTaskToDefault, updateTask } from '@/lib/dal'
import { defaultTasks, hashTask } from '@/lib/defaults/tasks'
import type { Task } from '@/types'
import { useEntities, type UseEntitiesResult } from './use-entities-plural'

/**
 * Hook for managing multiple tasks with modification tracking and reset capability
 *
 * @param searchQuery - Optional search query to filter tasks
 *
 * @example
 * ```tsx
 * const tasks = useTasks()
 *
 * return (
 *   <>
 *     {tasks.data.map((task) => (
 *       <div key={task.id}>
 *         <Input
 *           value={task.item}
 *           onChange={(e) => tasks.update(task.id, { item: e.target.value })}
 *         />
 *         <Switch
 *           checked={task.isComplete === 1}
 *           onCheckedChange={(checked) => tasks.update(task.id, { isComplete: checked ? 1 : 0 })}
 *         />
 *         {tasks.isModified(task.id) && (
 *           <Button onClick={() => tasks.reset(task.id)}>Reset to Default</Button>
 *         )}
 *       </div>
 *     ))}
 *   </>
 * )
 * ```
 */
export const useTasks = (searchQuery?: string): UseEntitiesResult<Task> => {
  return useEntities<Task>({
    queryKey: ['tasks', searchQuery],
    queryFn: () => getIncompleteTasks(searchQuery),
    updateFn: updateTask,
    resetFn: async (id: string) => {
      const defaultTask = defaultTasks.find((t) => t.id === id)
      if (!defaultTask) {
        throw new Error(`No default task found for id: ${id}`)
      }
      await resetTaskToDefault(id, defaultTask)
    },
    isModifiedFn: (task) => {
      if (!task.defaultHash) return false
      const currentHash = hashTask(task)
      return currentHash !== task.defaultHash
    },
    getIdFn: (task) => task.id,
  })
}
