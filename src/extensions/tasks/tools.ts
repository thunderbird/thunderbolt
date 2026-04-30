/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { deleteTasks as deleteTasksDal, getAllTasks } from '@/dal'
import { getDb } from '@/db/database'
import { tasksTable } from '@/db/tables'
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
    const db = getDb()
    const tasks = await db
      .insert(tasksTable)
      .values(
        params.tasks.map((task: string) => ({
          id: uuidv7(),
          item: task,
          order: 0,
          isComplete: 0,
        })),
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
    const db = getDb()
    const tasks = await getAllTasks(db)
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
    const db = getDb()
    await deleteTasksDal(db, params.taskIds)
    return {
      success: true,
    }
  },
}
