import { DatabaseSingleton } from '@/db/singleton'
import { tasksTable } from '@/db/tables'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import {
  createTask,
  deleteTask,
  deleteTasks,
  getAllTasks,
  getIncompleteTasks,
  getIncompleteTasksCount,
  updateTask,
} from './tasks'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from './test-utils'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

describe('Tasks DAL', () => {
  beforeEach(async () => {
    // Reset database before each test to prevent pollution from randomized test order
    await resetTestDatabase()
  })

  describe('getAllTasks', () => {
    it('should return all tasks', async () => {
      const db = DatabaseSingleton.instance.db
      const taskId1 = uuidv7()
      const taskId2 = uuidv7()
      const taskId3 = uuidv7()

      await db.insert(tasksTable).values([
        { id: taskId1, item: 'Task 1', order: 1, isComplete: 0 },
        { id: taskId2, item: 'Task 2', order: 2, isComplete: 0 },
        { id: taskId3, item: 'Task 3', order: 3, isComplete: 0 },
      ])

      const tasks = await getAllTasks()
      expect(tasks).toHaveLength(3)
      expect(tasks.map((t) => t.id)).toContain(taskId1)
      expect(tasks.map((t) => t.id)).toContain(taskId2)
      expect(tasks.map((t) => t.id)).toContain(taskId3)
    })
  })

  describe('getIncompleteTasks', () => {
    it('should return empty array when no tasks exist', async () => {
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
      const [{ count }] = await getIncompleteTasksCount()
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

      const [{ count }] = await getIncompleteTasksCount()
      expect(count).toBe(2)
    })
  })

  describe('deleteTask', () => {
    it('should soft delete a task by id (set deletedAt)', async () => {
      const db = DatabaseSingleton.instance.db
      const taskId = uuidv7()

      await db.insert(tasksTable).values({
        id: taskId,
        item: 'Task to delete',
        isComplete: 0,
        order: 1,
      })

      // Verify task exists
      const tasksBefore = await getIncompleteTasks()
      expect(tasksBefore).toHaveLength(1)

      await deleteTask(taskId)

      // Verify task is soft deleted (not in getIncompleteTasks)
      const tasksAfter = await getIncompleteTasks()
      expect(tasksAfter).toHaveLength(0)

      // But should still exist in database with deletedAt set
      const rawTasks = await db.select().from(tasksTable)
      expect(rawTasks).toHaveLength(1)
      expect(rawTasks[0]?.deletedAt).not.toBeNull()
    })

    it('should not throw when deleting non-existent task', async () => {
      await expect(deleteTask('non-existent-id')).resolves.toBeUndefined()
    })

    it('should not return soft-deleted task via getAllTasks', async () => {
      const db = DatabaseSingleton.instance.db
      const taskId = uuidv7()

      await db.insert(tasksTable).values({
        id: taskId,
        item: 'Task to delete',
        isComplete: 0,
        order: 1,
      })

      // Verify task exists
      const tasksBefore = await getAllTasks()
      expect(tasksBefore).toHaveLength(1)

      await deleteTask(taskId)

      // Verify task is not returned by getAllTasks
      const tasksAfter = await getAllTasks()
      expect(tasksAfter).toHaveLength(0)
    })

    it('should preserve original deletedAt datetime for already-deleted task', async () => {
      const db = DatabaseSingleton.instance.db
      const taskId = uuidv7()
      const originalDeletedAt = '2024-01-15T12:00:00.000Z'

      await db.insert(tasksTable).values({
        id: taskId,
        item: 'Already deleted task',
        isComplete: 0,
        order: 1,
        deletedAt: originalDeletedAt,
      })

      // Call delete again on already-deleted task
      await deleteTask(taskId)

      // Verify original deletedAt is preserved
      const rawTask = await db.select().from(tasksTable).get()
      expect(rawTask?.deletedAt).toBe(originalDeletedAt)
    })
  })

  describe('deleteTasks', () => {
    it('should soft delete multiple tasks by ids (set deletedAt)', async () => {
      const db = DatabaseSingleton.instance.db
      const taskId1 = uuidv7()
      const taskId2 = uuidv7()
      const taskId3 = uuidv7()

      await db.insert(tasksTable).values([
        { id: taskId1, item: 'Task 1', isComplete: 0, order: 1 },
        { id: taskId2, item: 'Task 2', isComplete: 0, order: 2 },
        { id: taskId3, item: 'Task 3', isComplete: 0, order: 3 },
      ])

      // Verify all tasks exist
      const tasksBefore = await getIncompleteTasks()
      expect(tasksBefore).toHaveLength(3)

      await deleteTasks([taskId1, taskId3])

      // Verify only task 2 is visible
      const tasksAfter = await getIncompleteTasks()
      expect(tasksAfter).toHaveLength(1)
      expect(tasksAfter[0]?.id).toBe(taskId2)

      // But all should still exist in database
      const rawTasks = await db.select().from(tasksTable)
      expect(rawTasks).toHaveLength(3)

      // Two should have deletedAt set
      const deletedTasks = rawTasks.filter((t) => t.deletedAt !== null)
      expect(deletedTasks).toHaveLength(2)
    })

    it('should handle empty array', async () => {
      const db = DatabaseSingleton.instance.db
      const taskId = uuidv7()

      await db.insert(tasksTable).values({
        id: taskId,
        item: 'Task',
        isComplete: 0,
        order: 1,
      })

      await deleteTasks([])

      // Verify task still exists
      const tasks = await getIncompleteTasks()
      expect(tasks).toHaveLength(1)
    })

    it('should not throw when deleting non-existent tasks', async () => {
      await expect(deleteTasks(['non-existent-1', 'non-existent-2'])).resolves.toBeUndefined()
    })

    it('should preserve original deletedAt datetimes for already-deleted tasks', async () => {
      const db = DatabaseSingleton.instance.db
      const taskId1 = uuidv7()
      const taskId2 = uuidv7()
      const taskId3 = uuidv7()
      const originalDeletedAt = '2024-01-15T12:00:00.000Z'

      await db.insert(tasksTable).values([
        { id: taskId1, item: 'Already deleted', isComplete: 0, order: 1, deletedAt: originalDeletedAt },
        { id: taskId2, item: 'Active task', isComplete: 0, order: 2, deletedAt: null },
        { id: taskId3, item: 'Another active', isComplete: 0, order: 3, deletedAt: null },
      ])

      // Delete all three tasks (one already deleted, two active)
      await deleteTasks([taskId1, taskId2, taskId3])

      // Verify original deletedAt is preserved for already-deleted task
      const rawTasks = await db.select().from(tasksTable)
      const alreadyDeleted = rawTasks.find((t) => t.id === taskId1)
      const newlyDeleted1 = rawTasks.find((t) => t.id === taskId2)
      const newlyDeleted2 = rawTasks.find((t) => t.id === taskId3)

      expect(alreadyDeleted?.deletedAt).toBe(originalDeletedAt)
      expect(newlyDeleted1?.deletedAt).not.toBe(originalDeletedAt)
      expect(newlyDeleted1?.deletedAt).not.toBeNull()
      expect(newlyDeleted2?.deletedAt).not.toBe(originalDeletedAt)
      expect(newlyDeleted2?.deletedAt).not.toBeNull()
    })
  })

  describe('updateTask', () => {
    it('should update a task item', async () => {
      const db = DatabaseSingleton.instance.db
      const taskId = uuidv7()

      await db.insert(tasksTable).values({
        id: taskId,
        item: 'Original item',
        isComplete: 0,
        order: 1,
      })

      await updateTask(taskId, { item: 'Updated item' })

      const tasks = await getIncompleteTasks()
      expect(tasks[0]?.item).toBe('Updated item')
    })

    it('should update task order', async () => {
      const db = DatabaseSingleton.instance.db
      const taskId = uuidv7()

      await db.insert(tasksTable).values({
        id: taskId,
        item: 'Task',
        isComplete: 0,
        order: 1,
      })

      await updateTask(taskId, { order: 10 })

      const tasks = await getIncompleteTasks()
      expect(tasks[0]?.order).toBe(10)
    })

    it('should mark a task as complete', async () => {
      const db = DatabaseSingleton.instance.db
      const taskId = uuidv7()

      await db.insert(tasksTable).values({
        id: taskId,
        item: 'Task to complete',
        isComplete: 0,
        order: 1,
      })

      // Verify task is incomplete
      const tasksBefore = await getIncompleteTasks()
      expect(tasksBefore).toHaveLength(1)

      await updateTask(taskId, { isComplete: 1 })

      // Verify task is no longer in incomplete list
      const tasksAfter = await getIncompleteTasks()
      expect(tasksAfter).toHaveLength(0)
    })

    it('should update multiple fields at once', async () => {
      const db = DatabaseSingleton.instance.db
      const taskId = uuidv7()

      await db.insert(tasksTable).values({
        id: taskId,
        item: 'Original',
        isComplete: 0,
        order: 1,
      })

      await updateTask(taskId, { item: 'Updated', order: 5 })

      const tasks = await getIncompleteTasks()
      expect(tasks[0]?.item).toBe('Updated')
      expect(tasks[0]?.order).toBe(5)
    })

    it('should not throw when updating non-existent task', async () => {
      await expect(updateTask('non-existent-id', { item: 'test' })).resolves.toBeUndefined()
    })

    it('should not update defaultHash field', async () => {
      const db = DatabaseSingleton.instance.db
      const taskId = uuidv7()

      await db.insert(tasksTable).values({
        id: taskId,
        item: 'Task',
        isComplete: 0,
        order: 1,
        defaultHash: 'original-hash',
      })

      // Try to update defaultHash (should be ignored)
      await updateTask(taskId, { item: 'Updated', defaultHash: 'new-hash' } as Parameters<typeof updateTask>[1])

      // Verify defaultHash was not changed
      const task = await db.select().from(tasksTable).get()
      expect(task?.defaultHash).toBe('original-hash')
      expect(task?.item).toBe('Updated')
    })
  })

  describe('createTask', () => {
    it('should create a new task', async () => {
      const taskId = uuidv7()

      await createTask({
        id: taskId,
        item: 'New task',
        order: 1,
        isComplete: 0,
      })

      const tasks = await getIncompleteTasks()
      expect(tasks).toHaveLength(1)
      expect(tasks[0]?.id).toBe(taskId)
      expect(tasks[0]?.item).toBe('New task')
    })

    it('should create multiple tasks', async () => {
      await createTask({ id: uuidv7(), item: 'Task 1', order: 1, isComplete: 0 })
      await createTask({ id: uuidv7(), item: 'Task 2', order: 2, isComplete: 0 })

      const tasks = await getIncompleteTasks()
      expect(tasks).toHaveLength(2)
    })

    it('should create a completed task that is excluded from incomplete tasks', async () => {
      await createTask({
        id: uuidv7(),
        item: 'Completed task',
        order: 1,
        isComplete: 1,
      })

      const incompleteTasks = await getIncompleteTasks()
      expect(incompleteTasks).toHaveLength(0)

      const [{ count }] = await getIncompleteTasksCount()
      expect(count).toBe(0)
    })
  })
})
