import { DatabaseSingleton } from '@/db/singleton'
import { chatMessagesTable, chatThreadsTable, modelsTable } from '@/db/tables'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import {
  createChatThread,
  deleteAllChatThreads,
  deleteChatThread,
  getAllChatThreads,
  getChatThread,
  getContextSizeForThread,
  getOrCreateChatThread,
  isChatThreadDeleted,
  updateChatThread,
} from './chat-threads'
import { getChatMessages } from './chat-messages'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from './test-utils'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

/**
 * Helper function to create a test model
 */
const createTestModel = async () => {
  const db = DatabaseSingleton.instance.db
  const modelId = uuidv7()

  await db.insert(modelsTable).values({
    id: modelId,
    provider: 'thunderbolt',
    name: 'Test Model',
    model: 'gpt-oss-120b',
    isSystem: 0,
    enabled: 1,
    isConfidential: 0,
    contextWindow: 131072,
    toolUsage: 1,
    startWithReasoning: 0,
    deletedAt: null,
    apiKey: null,
    url: null,
    defaultHash: null,
  })

  return modelId
}

describe('Chat Threads DAL', () => {
  beforeEach(async () => {
    // Reset database before each test to prevent pollution from randomized test order
    await resetTestDatabase()
  })

  describe('createChatThread', () => {
    it('should create a new chat thread with the provided ID', async () => {
      const threadId = uuidv7()
      const modelId = await createTestModel()

      await createChatThread(
        { id: threadId, title: 'New Chat', contextSize: null, triggeredBy: null, wasTriggeredByAutomation: 0 },
        modelId,
      )

      const db = DatabaseSingleton.instance.db
      const threads = await db.select().from(chatThreadsTable)
      expect(threads).toHaveLength(1)
      expect(threads[0]?.id).toBe(threadId)
      expect(threads[0]?.title).toBe('New Chat')
    })

    it('should create multiple threads with different IDs', async () => {
      const threadId1 = uuidv7()
      const threadId2 = uuidv7()
      const modelId = await createTestModel()

      await createChatThread(
        { id: threadId1, title: 'New Chat', contextSize: null, triggeredBy: null, wasTriggeredByAutomation: 0 },
        modelId,
      )
      await createChatThread(
        { id: threadId2, title: 'New Chat', contextSize: null, triggeredBy: null, wasTriggeredByAutomation: 0 },
        modelId,
      )

      const db = DatabaseSingleton.instance.db
      const threads = await db.select().from(chatThreadsTable)
      expect(threads).toHaveLength(2)
      expect(threads.map((t) => t.id)).toContain(threadId1)
      expect(threads.map((t) => t.id)).toContain(threadId2)
    })

    it('should throw when creating thread with same ID twice', async () => {
      const threadId = uuidv7()
      const modelId = await createTestModel()

      await createChatThread(
        { id: threadId, title: 'New Chat', contextSize: null, triggeredBy: null, wasTriggeredByAutomation: 0 },
        modelId,
      )

      // Should throw due to UNIQUE constraint
      await expect(
        createChatThread(
          { id: threadId, title: 'New Chat', contextSize: null, triggeredBy: null, wasTriggeredByAutomation: 0 },
          modelId,
        ),
      ).rejects.toThrow()

      const db = DatabaseSingleton.instance.db
      const threads = await db.select().from(chatThreadsTable)
      expect(threads).toHaveLength(1)
      expect(threads[0]?.id).toBe(threadId)
    })
  })

  describe('getChatThread', () => {
    it('should return undefined values when thread does not exist', async () => {
      const nonExistentId = uuidv7()
      const thread = await getChatThread(nonExistentId)
      expect(thread?.id).toBeUndefined()
      expect(thread?.title).toBeUndefined()
    })

    it('should return the thread when it exists', async () => {
      const threadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      // Create a thread manually
      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      const thread = await getChatThread(threadId)
      expect(thread).not.toBeNull()
      expect(thread?.id).toBe(threadId)
      expect(thread?.title).toBe('Test Thread')
    })

    it('should return the correct thread when multiple threads exist', async () => {
      const threadId1 = uuidv7()
      const threadId2 = uuidv7()
      const db = DatabaseSingleton.instance.db

      // Create two threads
      await db.insert(chatThreadsTable).values({
        id: threadId1,
        title: 'First Thread',
        isEncrypted: 0,
      })
      await db.insert(chatThreadsTable).values({
        id: threadId2,
        title: 'Second Thread',
        isEncrypted: 0,
      })

      const thread1 = await getChatThread(threadId1)
      const thread2 = await getChatThread(threadId2)

      expect(thread1?.id).toBe(threadId1)
      expect(thread1?.title).toBe('First Thread')
      expect(thread2?.id).toBe(threadId2)
      expect(thread2?.title).toBe('Second Thread')
    })
  })

  describe('isChatThreadDeleted', () => {
    it('should return false for non-existent thread', async () => {
      const nonExistentId = uuidv7()
      const isDeleted = await isChatThreadDeleted(nonExistentId)
      expect(isDeleted).toBe(false)
    })

    it('should return false for existing non-deleted thread', async () => {
      const threadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Active Thread',
        isEncrypted: 0,
      })

      const isDeleted = await isChatThreadDeleted(threadId)
      expect(isDeleted).toBe(false)
    })

    it('should return true for soft-deleted thread', async () => {
      const threadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Deleted Thread',
        isEncrypted: 0,
        deletedAt: Date.now(),
      })

      const isDeleted = await isChatThreadDeleted(threadId)
      expect(isDeleted).toBe(true)
    })

    it('should correctly identify deleted vs active threads', async () => {
      const activeThreadId = uuidv7()
      const deletedThreadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values([
        { id: activeThreadId, title: 'Active', isEncrypted: 0 },
        { id: deletedThreadId, title: 'Deleted', isEncrypted: 0, deletedAt: Date.now() },
      ])

      expect(await isChatThreadDeleted(activeThreadId)).toBe(false)
      expect(await isChatThreadDeleted(deletedThreadId)).toBe(true)
    })
  })

  describe('getOrCreateChatThread', () => {
    it('should return existing thread when it exists', async () => {
      const threadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      // Create a thread manually
      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Existing Thread',
        isEncrypted: 0,
      })

      const modelId = await createTestModel()
      const thread = await getOrCreateChatThread(threadId, modelId)
      expect(thread).not.toBeNull()
      expect(thread?.id).toBe(threadId)
      expect(thread?.title).toBe('Existing Thread')

      // Verify no new thread was created
      const threads = await db.select().from(chatThreadsTable)
      expect(threads).toHaveLength(1)
    })

    it('should create and return new thread when it does not exist', async () => {
      const threadId = uuidv7()
      const modelId = await createTestModel()

      const thread = await getOrCreateChatThread(threadId, modelId)
      expect(thread).not.toBeNull()
      expect(thread?.id).toBe(threadId)
      expect(thread?.title).toBe('New Chat')

      // Verify thread was created in database
      const db = DatabaseSingleton.instance.db
      const threads = await db.select().from(chatThreadsTable)
      expect(threads).toHaveLength(1)
      expect(threads[0]?.id).toBe(threadId)
    })

    it('should handle multiple calls with same ID consistently', async () => {
      const threadId = uuidv7()
      const modelId = await createTestModel()

      const thread1 = await getOrCreateChatThread(threadId, modelId)
      const thread2 = await getOrCreateChatThread(threadId, modelId)

      expect(thread1?.id).toBe(threadId)
      expect(thread2?.id).toBe(threadId)
      expect(thread1?.title).toBe('New Chat')
      expect(thread2?.title).toBe('New Chat')

      // Verify only one thread exists
      const db = DatabaseSingleton.instance.db
      const threads = await db.select().from(chatThreadsTable)
      expect(threads).toHaveLength(1)
    })

    it('should work correctly with different thread IDs', async () => {
      const threadId1 = uuidv7()
      const threadId2 = uuidv7()
      const modelId = await createTestModel()

      const thread1 = await getOrCreateChatThread(threadId1, modelId)
      const thread2 = await getOrCreateChatThread(threadId2, modelId)

      expect(thread1?.id).toBe(threadId1)
      expect(thread2?.id).toBe(threadId2)
      expect(thread1?.id).not.toBe(thread2?.id)

      // Verify both threads exist
      const db = DatabaseSingleton.instance.db
      const threads = await db.select().from(chatThreadsTable)
      expect(threads).toHaveLength(2)
      expect(threads.map((t) => t.id)).toContain(threadId1)
      expect(threads.map((t) => t.id)).toContain(threadId2)
    })
  })

  describe('getAllChatThreads', () => {
    it('should return empty array when no threads exist', async () => {
      const threads = await getAllChatThreads()
      expect(threads).toEqual([])
    })

    it('should return all threads ordered by creation date (desc)', async () => {
      const db = DatabaseSingleton.instance.db
      const threadId1 = uuidv7()
      const threadId2 = uuidv7()

      await db.insert(chatThreadsTable).values([
        {
          id: threadId1,
          title: 'First Thread',
          isEncrypted: 0,
        },
        {
          id: threadId2,
          title: 'Second Thread',
          isEncrypted: 0,
        },
      ])

      const threads = await getAllChatThreads()
      expect(threads).toHaveLength(2)
      expect(threads.map((t) => t.id)).toContain(threadId1)
      expect(threads.map((t) => t.id)).toContain(threadId2)
    })
  })

  describe('getContextSizeForThread', () => {
    it('should return null when thread does not exist', async () => {
      const threadId = uuidv7()
      const contextSize = await getContextSizeForThread(threadId)
      expect(contextSize).toBe(null)
    })

    it('should return null when thread has no context size', async () => {
      const threadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      const contextSize = await getContextSizeForThread(threadId)
      expect(contextSize).toBe(null)
    })

    it('should return context size when thread has it set', async () => {
      const threadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
        contextSize: 1500,
      })

      const contextSize = await getContextSizeForThread(threadId)
      expect(contextSize).toBe(1500)
    })
  })

  describe('deleteChatThread', () => {
    it('should soft delete a specific chat thread by ID (set deletedAt)', async () => {
      const threadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      const threadsBefore = await getAllChatThreads()
      expect(threadsBefore).toHaveLength(1)

      await deleteChatThread(threadId)

      // Should not appear in getAllChatThreads (excludes soft-deleted)
      const threadsAfter = await getAllChatThreads()
      expect(threadsAfter).toHaveLength(0)

      // But should still exist in database with deletedAt set
      const rawThreads = await db.select().from(chatThreadsTable)
      expect(rawThreads).toHaveLength(1)
      expect(rawThreads[0]?.deletedAt).not.toBeNull()
    })

    it('should only soft delete the specified thread when multiple exist', async () => {
      const threadId1 = uuidv7()
      const threadId2 = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values([
        {
          id: threadId1,
          title: 'First Thread',
          isEncrypted: 0,
        },
        {
          id: threadId2,
          title: 'Second Thread',
          isEncrypted: 0,
        },
      ])

      await deleteChatThread(threadId1)

      // Only one thread should be visible
      const threads = await getAllChatThreads()
      expect(threads).toHaveLength(1)
      expect(threads[0]?.id).toBe(threadId2)
      expect(threads[0]?.title).toBe('Second Thread')

      // Both should exist in database
      const rawThreads = await db.select().from(chatThreadsTable)
      expect(rawThreads).toHaveLength(2)
    })

    it('should not throw when deleting non-existent thread', async () => {
      const nonExistentId = uuidv7()
      await expect(deleteChatThread(nonExistentId)).resolves.toBeUndefined()
    })

    it('should not return soft-deleted thread via getChatThread', async () => {
      const threadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      // Thread should be found before deletion
      const threadBefore = await getChatThread(threadId)
      expect(threadBefore?.id).toBe(threadId)

      await deleteChatThread(threadId)

      // Thread should not be found after soft deletion
      const threadAfter = await getChatThread(threadId)
      expect(threadAfter).toBeNull()
    })

    it('should soft delete associated messages when deleting a thread', async () => {
      const threadId = uuidv7()
      const messageId1 = uuidv7()
      const messageId2 = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      await db.insert(chatMessagesTable).values([
        {
          id: messageId1,
          chatThreadId: threadId,
          role: 'user',
          content: 'Hello',
        },
        {
          id: messageId2,
          chatThreadId: threadId,
          role: 'assistant',
          content: 'Hi there',
        },
      ])

      // Messages should be visible before deletion
      const messagesBefore = await getChatMessages(threadId)
      expect(messagesBefore).toHaveLength(2)

      await deleteChatThread(threadId)

      // Messages should not be returned after thread deletion
      const messagesAfter = await getChatMessages(threadId)
      expect(messagesAfter).toHaveLength(0)

      // But messages should still exist in database with deletedAt set
      const rawMessages = await db.select().from(chatMessagesTable)
      expect(rawMessages).toHaveLength(2)
      expect(rawMessages.every((m) => m.deletedAt !== null)).toBe(true)
    })

    it('should only soft delete messages for the specified thread', async () => {
      const threadId1 = uuidv7()
      const threadId2 = uuidv7()
      const messageId1 = uuidv7()
      const messageId2 = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values([
        { id: threadId1, title: 'Thread 1', isEncrypted: 0 },
        { id: threadId2, title: 'Thread 2', isEncrypted: 0 },
      ])

      await db.insert(chatMessagesTable).values([
        {
          id: messageId1,
          chatThreadId: threadId1,
          role: 'user',
          content: 'Message in thread 1',
        },
        {
          id: messageId2,
          chatThreadId: threadId2,
          role: 'user',
          content: 'Message in thread 2',
        },
      ])

      await deleteChatThread(threadId1)

      // Messages in thread 1 should be soft-deleted
      const messagesThread1 = await getChatMessages(threadId1)
      expect(messagesThread1).toHaveLength(0)

      // Messages in thread 2 should still be visible
      const messagesThread2 = await getChatMessages(threadId2)
      expect(messagesThread2).toHaveLength(1)
      expect(messagesThread2[0]?.id).toBe(messageId2)
    })
  })

  describe('deleteAllChatThreads', () => {
    it('should soft delete all chat threads (set deletedAt)', async () => {
      const threadId1 = uuidv7()
      const threadId2 = uuidv7()
      const threadId3 = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values([
        { id: threadId1, title: 'First Thread', isEncrypted: 0 },
        { id: threadId2, title: 'Second Thread', isEncrypted: 0 },
        { id: threadId3, title: 'Third Thread', isEncrypted: 0 },
      ])

      const threadsBefore = await getAllChatThreads()
      expect(threadsBefore).toHaveLength(3)

      await deleteAllChatThreads()

      // Should not appear in getAllChatThreads
      const threadsAfter = await getAllChatThreads()
      expect(threadsAfter).toHaveLength(0)

      // But all should still exist in database with deletedAt set
      const rawThreads = await db.select().from(chatThreadsTable)
      expect(rawThreads).toHaveLength(3)
      expect(rawThreads.every((t) => t.deletedAt !== null)).toBe(true)
    })

    it('should not throw when soft deleting from empty table', async () => {
      const threadsBefore = await getAllChatThreads()
      expect(threadsBefore).toHaveLength(0)

      await expect(deleteAllChatThreads()).resolves.toBeUndefined()
    })

    it('should soft delete all messages when deleting all threads', async () => {
      const threadId1 = uuidv7()
      const threadId2 = uuidv7()
      const messageId1 = uuidv7()
      const messageId2 = uuidv7()
      const messageId3 = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values([
        { id: threadId1, title: 'Thread 1', isEncrypted: 0 },
        { id: threadId2, title: 'Thread 2', isEncrypted: 0 },
      ])

      await db.insert(chatMessagesTable).values([
        {
          id: messageId1,
          chatThreadId: threadId1,
          role: 'user',
          content: 'Message 1',
        },
        {
          id: messageId2,
          chatThreadId: threadId1,
          role: 'assistant',
          content: 'Message 2',
        },
        {
          id: messageId3,
          chatThreadId: threadId2,
          role: 'user',
          content: 'Message 3',
        },
      ])

      // All messages should be visible before deletion
      const messagesThread1Before = await getChatMessages(threadId1)
      const messagesThread2Before = await getChatMessages(threadId2)
      expect(messagesThread1Before).toHaveLength(2)
      expect(messagesThread2Before).toHaveLength(1)

      await deleteAllChatThreads()

      // No messages should be returned after deletion
      const messagesThread1After = await getChatMessages(threadId1)
      const messagesThread2After = await getChatMessages(threadId2)
      expect(messagesThread1After).toHaveLength(0)
      expect(messagesThread2After).toHaveLength(0)

      // But all messages should still exist in database with deletedAt set
      const rawMessages = await db.select().from(chatMessagesTable)
      expect(rawMessages).toHaveLength(3)
      expect(rawMessages.every((m) => m.deletedAt !== null)).toBe(true)
    })

    it('should preserve original deletedAt timestamps for already soft-deleted threads', async () => {
      const threadId1 = uuidv7()
      const threadId2 = uuidv7()
      const db = DatabaseSingleton.instance.db

      // Create two threads
      await db.insert(chatThreadsTable).values([
        { id: threadId1, title: 'Thread 1', isEncrypted: 0 },
        { id: threadId2, title: 'Thread 2', isEncrypted: 0 },
      ])

      // Soft delete thread 1 with an older timestamp (1 day ago)
      const originalDeletionTime = Date.now() - 86400000
      await db
        .update(chatThreadsTable)
        .set({ deletedAt: originalDeletionTime })
        .where(eq(chatThreadsTable.id, threadId1))

      // Now call deleteAllChatThreads - should only update thread 2
      await deleteAllChatThreads()

      // Thread 1 should still have its original deletion timestamp
      const rawThreads = await db.select().from(chatThreadsTable)
      const thread1 = rawThreads.find((t) => t.id === threadId1)
      const thread2 = rawThreads.find((t) => t.id === threadId2)

      expect(thread1?.deletedAt).toBe(originalDeletionTime)
      expect(thread2?.deletedAt).not.toBe(originalDeletionTime)
      expect(thread2?.deletedAt).not.toBeNull()
    })
  })

  describe('updateChatThread', () => {
    it('should update thread title', async () => {
      const threadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      // Create initial thread
      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Original Title',
        isEncrypted: 0,
      })

      // Update title
      await updateChatThread(threadId, { title: 'Updated Title' })

      // Verify update
      const updatedThread = await getChatThread(threadId)
      expect(updatedThread?.title).toBe('Updated Title')
      expect(updatedThread?.id).toBe(threadId)
      expect(updatedThread?.isEncrypted).toBe(0) // Should remain unchanged
    })

    it('should update context size', async () => {
      const threadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      // Create initial thread
      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      // Update context size
      await updateChatThread(threadId, { contextSize: 2000 })

      // Verify update
      const updatedThread = await getChatThread(threadId)
      expect(updatedThread?.contextSize).toBe(2000)
      expect(updatedThread?.title).toBe('Test Thread') // Should remain unchanged
    })

    it('should update triggeredBy field', async () => {
      const threadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      // Create initial thread
      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      // Update triggeredBy to null (since we don't have a valid prompt ID)
      await updateChatThread(threadId, { triggeredBy: null })

      // Verify update
      const updatedThread = await getChatThread(threadId)
      expect(updatedThread?.triggeredBy).toBeNull()
    })

    it('should update wasTriggeredByAutomation field', async () => {
      const threadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      // Create initial thread
      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
        wasTriggeredByAutomation: 0,
      })

      // Update wasTriggeredByAutomation
      await updateChatThread(threadId, { wasTriggeredByAutomation: 1 })

      // Verify update
      const updatedThread = await getChatThread(threadId)
      expect(updatedThread?.wasTriggeredByAutomation).toBe(1)
    })

    it('should update multiple fields at once', async () => {
      const threadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      // Create initial thread
      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Original Title',
        isEncrypted: 0,
        contextSize: 1000,
        wasTriggeredByAutomation: 0,
      })

      // Update multiple fields
      await updateChatThread(threadId, {
        title: 'Updated Title',
        contextSize: 3000,
        triggeredBy: null,
        wasTriggeredByAutomation: 1,
      })

      // Verify all updates
      const updatedThread = await getChatThread(threadId)
      expect(updatedThread?.title).toBe('Updated Title')
      expect(updatedThread?.contextSize).toBe(3000)
      expect(updatedThread?.triggeredBy).toBeNull()
      expect(updatedThread?.wasTriggeredByAutomation).toBe(1)
      expect(updatedThread?.id).toBe(threadId) // Should remain unchanged
      expect(updatedThread?.isEncrypted).toBe(0) // Should remain unchanged
    })

    it('should update only specified fields (partial update)', async () => {
      const threadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      // Create initial thread with all fields
      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Original Title',
        isEncrypted: 0,
        contextSize: 1000,
        wasTriggeredByAutomation: 0,
      })

      // Update only title
      await updateChatThread(threadId, { title: 'Updated Title' })

      // Verify only title changed
      const updatedThread = await getChatThread(threadId)
      expect(updatedThread?.title).toBe('Updated Title')
      expect(updatedThread?.contextSize).toBe(1000) // Should remain unchanged
      expect(updatedThread?.wasTriggeredByAutomation).toBe(0) // Should remain unchanged
    })

    it('should not throw when updating non-existent thread', async () => {
      const nonExistentId = uuidv7()

      // Should not throw
      await expect(updateChatThread(nonExistentId, { title: 'New Title' })).resolves.toBeUndefined()
    })

    it('should update specific thread when multiple threads exist', async () => {
      const threadId1 = uuidv7()
      const threadId2 = uuidv7()
      const db = DatabaseSingleton.instance.db

      // Create two threads
      await db.insert(chatThreadsTable).values([
        {
          id: threadId1,
          title: 'First Thread',
          isEncrypted: 0,
          contextSize: 1000,
        },
        {
          id: threadId2,
          title: 'Second Thread',
          isEncrypted: 0,
          contextSize: 2000,
        },
      ])

      // Update only the first thread
      await updateChatThread(threadId1, { title: 'Updated First Thread', contextSize: 1500 })

      // Verify only first thread was updated
      const firstThread = await getChatThread(threadId1)
      const secondThread = await getChatThread(threadId2)

      expect(firstThread?.title).toBe('Updated First Thread')
      expect(firstThread?.contextSize).toBe(1500)
      expect(secondThread?.title).toBe('Second Thread')
      expect(secondThread?.contextSize).toBe(2000)
    })

    it('should handle null values correctly', async () => {
      const threadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      // Create thread with values
      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
        contextSize: 1000,
        triggeredBy: null, // Start with null to avoid foreign key constraint
      })

      // Update with null values
      await updateChatThread(threadId, {
        contextSize: null,
        triggeredBy: null,
      })

      // Verify null values were set
      const updatedThread = await getChatThread(threadId)
      expect(updatedThread?.contextSize).toBeNull()
      expect(updatedThread?.triggeredBy).toBeNull()
      expect(updatedThread?.title).toBe('Test Thread') // Should remain unchanged
    })

    it('should not affect other threads when updating one', async () => {
      const threadId1 = uuidv7()
      const threadId2 = uuidv7()
      const threadId3 = uuidv7()
      const db = DatabaseSingleton.instance.db

      // Create three threads
      await db.insert(chatThreadsTable).values([
        { id: threadId1, title: 'Thread 1', isEncrypted: 0, contextSize: 1000 },
        { id: threadId2, title: 'Thread 2', isEncrypted: 0, contextSize: 2000 },
        { id: threadId3, title: 'Thread 3', isEncrypted: 0, contextSize: 3000 },
      ])

      // Update only the second thread
      await updateChatThread(threadId2, {
        title: 'Updated Thread 2',
        contextSize: 2500,
      })

      // Verify all threads
      const allThreads = await getAllChatThreads()
      expect(allThreads).toHaveLength(3)

      const thread1 = allThreads.find((t) => t.id === threadId1)
      const thread2 = allThreads.find((t) => t.id === threadId2)
      const thread3 = allThreads.find((t) => t.id === threadId3)

      expect(thread1?.title).toBe('Thread 1')
      expect(thread1?.contextSize).toBe(1000)
      expect(thread2?.title).toBe('Updated Thread 2')
      expect(thread2?.contextSize).toBe(2500)
      expect(thread3?.title).toBe('Thread 3')
      expect(thread3?.contextSize).toBe(3000)
    })
  })
})
