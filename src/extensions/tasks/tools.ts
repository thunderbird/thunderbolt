import { getDrizzleDatabase } from '@/db/singleton'
import { todosTable } from '@/db/tables'
import { inArray } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'

export const addTasks = {
  name: 'addTasks',
  description: "Add a task to the user's task (to do) list.",
  verb: 'Adding tasks',
  parameters: z.object({
    tasks: z.array(z.string()).describe("The tasks to add to the user's task (to do) list."),
  }),
  execute: async (params: { tasks: string[] }) => {
    const { db } = await getDrizzleDatabase()
    const tasks = await db
      .insert(todosTable)
      .values(
        params.tasks.map((task: string) => ({
          id: uuidv7(),
          item: task,
        }))
      )
      .returning()
    return tasks
  },
}

export const getTasks = {
  name: 'getTasks',
  description: "Get the user's task (to do) list.",
  verb: 'Getting tasks',
  parameters: z.object({}),
  execute: async () => {
    const { db } = await getDrizzleDatabase()
    const tasks = await db.select().from(todosTable)
    return tasks
  },
}

export const deleteTasks = {
  name: 'deleteTasks',
  description: "Delete a task from the user's task (to do) list.",
  verb: 'Deleting tasks',
  parameters: z.object({
    taskIds: z.array(z.string()).describe("The IDs of the tasks to delete from the user's task (to do) list."),
  }),
  execute: async (params: { taskIds: string[] }) => {
    const { db } = await getDrizzleDatabase()
    await db.delete(todosTable).where(inArray(todosTable.id, params.taskIds))
    return {
      success: true,
    }
  },
}
