import { DatabaseSingleton } from '@/db/singleton'
import { tasksTable } from '@/db/tables'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import { getIncompleteTasks, getIncompleteTasksCount } from './tasks'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from './test-utils'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

describe('Tasks DAL', () => {
  afterEach(async () => {
    await resetTestDatabase()
  })

  describe('getIncompleteTasks', () => {
    it('should return empty array when no tasks exist', async () => {
      const db = DatabaseSingleton.instance.db
      await db.delete(tasksTable)

      const tasks = await getIncompleteTasks()
      expect(tasks).toEqual([])
    })

    it('should return only incomplete tasks', async () => {
      const db = DatabaseSingleton.instance.db
      const taskId1 = uuidv7()
      const taskId2 = uuidv7()
      const taskId3 = uuidv7()

      await db.insert(tasksTable).values([
        {
          id: taskId1,
          item: 'Incomplete task 1',
          isComplete: 0,
          order: 1,
        },
        {
          id: taskId2,
          item: 'Incomplete task 2',
          isComplete: 0,
          order: 2,
        },
        {
          id: taskId3,
          item: 'Completed task',
          isComplete: 1,
          order: 3,
        },
      ])

      const tasks = await getIncompleteTasks()
      expect(tasks).toHaveLength(2)
      expect(tasks.map((t) => t.id)).toContain(taskId1)
      expect(tasks.map((t) => t.id)).toContain(taskId2)
      expect(tasks.map((t) => t.id)).not.toContain(taskId3)
    })

    it('should filter by search query', async () => {
      const db = DatabaseSingleton.instance.db
      const taskId1 = uuidv7()
      const taskId2 = uuidv7()

      await db.insert(tasksTable).values([
        {
          id: taskId1,
          item: 'Buy groceries',
          isComplete: 0,
          order: 1,
        },
        {
          id: taskId2,
          item: 'Walk the dog',
          isComplete: 0,
          order: 2,
        },
      ])

      const tasks = await getIncompleteTasks('groceries')
      expect(tasks).toHaveLength(1)
      expect(tasks[0]?.id).toBe(taskId1)
    })

    it('should return empty array when no tasks match search query', async () => {
      const db = DatabaseSingleton.instance.db
      const taskId = uuidv7()

      await db.insert(tasksTable).values({
        id: taskId,
        item: 'Buy groceries',
        isComplete: 0,
        order: 1,
      })

      const tasks = await getIncompleteTasks('nonexistent')
      expect(tasks).toEqual([])
    })
  })

  describe('getIncompleteTasksCount', () => {
    it('should return 0 when no incomplete tasks exist', async () => {
      const count = await getIncompleteTasksCount()
      expect(count).toBe(0)
    })

    it('should return correct count of incomplete tasks', async () => {
      const db = DatabaseSingleton.instance.db
      const taskId1 = uuidv7()
      const taskId2 = uuidv7()
      const taskId3 = uuidv7()

      await db.insert(tasksTable).values([
        {
          id: taskId1,
          item: 'Incomplete task 1',
          isComplete: 0,
          order: 1,
        },
        {
          id: taskId2,
          item: 'Incomplete task 2',
          isComplete: 0,
          order: 2,
        },
        {
          id: taskId3,
          item: 'Completed task',
          isComplete: 1,
          order: 3,
        },
      ])

      const count = await getIncompleteTasksCount()
      expect(count).toBe(2)
    })
  })
})
