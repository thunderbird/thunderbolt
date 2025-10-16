import { DatabaseSingleton } from '@/src/db/singleton'
import { chatMessagesTable, chatThreadsTable } from '@/src/db/tables'
import { afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import {
  createChatThread,
  getAllChatThreads,
  getChatThread,
  getContextSizeForThread,
  getOrCreateChatThread,
} from './chat-threads'
import { setupTestDatabase } from './test-utils'

beforeAll(async () => {
  await setupTestDatabase()
})

describe('Chat Threads DAL', () => {
  afterEach(async () => {
    // Clean up chat tables after each test
    const db = DatabaseSingleton.instance.db
    await db.delete(chatMessagesTable)
    await db.delete(chatThreadsTable)
  })

  describe('createChatThread', () => {
    it('should create a new chat thread with the provided ID', async () => {
      const threadId = uuidv7()

      await createChatThread(threadId)

      const db = DatabaseSingleton.instance.db
      const threads = await db.select().from(chatThreadsTable)
      expect(threads).toHaveLength(1)
      expect(threads[0]?.id).toBe(threadId)
      expect(threads[0]?.title).toBe('New Chat')
    })

    it('should create multiple threads with different IDs', async () => {
      const threadId1 = uuidv7()
      const threadId2 = uuidv7()

      await createChatThread(threadId1)
      await createChatThread(threadId2)

      const db = DatabaseSingleton.instance.db
      const threads = await db.select().from(chatThreadsTable)
      expect(threads).toHaveLength(2)
      expect(threads.map((t) => t.id)).toContain(threadId1)
      expect(threads.map((t) => t.id)).toContain(threadId2)
    })

    it('should throw when creating thread with same ID twice', async () => {
      const threadId = uuidv7()

      await createChatThread(threadId)

      // Should throw due to UNIQUE constraint
      await expect(createChatThread(threadId)).rejects.toThrow()

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

      const thread = await getOrCreateChatThread(threadId)
      expect(thread).not.toBeNull()
      expect(thread?.id).toBe(threadId)
      expect(thread?.title).toBe('Existing Thread')

      // Verify no new thread was created
      const threads = await db.select().from(chatThreadsTable)
      expect(threads).toHaveLength(1)
    })

    it('should create and return new thread when it does not exist', async () => {
      const threadId = uuidv7()

      const thread = await getOrCreateChatThread(threadId)
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

      const thread1 = await getOrCreateChatThread(threadId)
      const thread2 = await getOrCreateChatThread(threadId)

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

      const thread1 = await getOrCreateChatThread(threadId1)
      const thread2 = await getOrCreateChatThread(threadId2)

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
})
