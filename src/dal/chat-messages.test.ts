import { DatabaseSingleton } from '@/db/singleton'
import { chatMessagesTable, chatThreadsTable, modelsTable } from '@/db/tables'
import type { ThunderboltUIMessage } from '@/types'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import {
  deleteChatMessageAndDescendants,
  getChatMessages,
  getLastMessage,
  saveMessagesWithContextUpdate,
} from './chat-messages'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from './test-utils'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

describe('Chat Messages DAL', () => {
  beforeEach(async () => {
    // Reset database before each test to prevent pollution from randomized test order
    await resetTestDatabase()
  })

  describe('getChatMessages', () => {
    it('should return empty array when thread has no messages', async () => {
      const threadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      const messages = await getChatMessages(threadId)
      expect(messages).toEqual([])
    })

    it('should return messages for a thread', async () => {
      const threadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      const messageId1 = uuidv7()
      const messageId2 = uuidv7()

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
          content: 'Hi there!',
        },
      ])

      const messages = await getChatMessages(threadId)
      expect(messages).toHaveLength(2)
      expect(messages.map((m) => m.id)).toContain(messageId1)
      expect(messages.map((m) => m.id)).toContain(messageId2)
    })

    it('should return messages ordered by id', async () => {
      const threadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      const messageId1 = uuidv7()
      const messageId2 = uuidv7()

      // Insert messages in reverse order
      await db.insert(chatMessagesTable).values([
        {
          id: messageId2,
          chatThreadId: threadId,
          role: 'assistant',
          content: 'Second message',
        },
        {
          id: messageId1,
          chatThreadId: threadId,
          role: 'user',
          content: 'First message',
        },
      ])

      const messages = await getChatMessages(threadId)
      expect(messages).toHaveLength(2)
      expect(messages[0]?.id).toBe(messageId1)
      expect(messages[1]?.id).toBe(messageId2)
    })
  })

  describe('getLastMessage', () => {
    it('should return null when thread has no messages', async () => {
      const threadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      const lastMessage = await getLastMessage(threadId)
      expect(lastMessage).toBeNull()
    })

    it('should return the last message for a thread', async () => {
      const threadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      const messageId1 = uuidv7()
      const messageId2 = uuidv7()
      const modelId = uuidv7()

      // Create model first
      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Test Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
      })

      await db.insert(chatMessagesTable).values([
        {
          id: messageId1,
          chatThreadId: threadId,
          role: 'user',
          content: 'First message',
        },
        {
          id: messageId2,
          chatThreadId: threadId,
          role: 'assistant',
          content: 'Last message',
          modelId: modelId,
        },
      ])

      const lastMessage = await getLastMessage(threadId)
      expect(lastMessage).not.toBeUndefined()
      expect(lastMessage?.id).toBe(messageId2)
      expect(lastMessage?.modelId).toBe(modelId)
    })
  })

  describe('saveMessagesWithContextUpdate with parent_id', () => {
    it('should set parent_id to null for first message in empty thread', async () => {
      const threadId = uuidv7()
      const messageId = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      const messages: ThunderboltUIMessage[] = [
        {
          id: messageId,
          role: 'user',
          parts: [{ type: 'text', text: 'First message' }],
        },
      ]

      await saveMessagesWithContextUpdate(threadId, messages)

      const savedMessages = await db.select().from(chatMessagesTable).where(eq(chatMessagesTable.id, messageId))
      expect(savedMessages).toHaveLength(1)
      expect(savedMessages[0]?.parentId).toBe(null)
    })

    it('should set parent_id to last message when adding new message', async () => {
      const threadId = uuidv7()
      const messageId1 = uuidv7()
      const messageId2 = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      await db.insert(chatMessagesTable).values({
        id: messageId1,
        chatThreadId: threadId,
        role: 'user',
        content: 'First message',
        parentId: null,
      })

      const messages: ThunderboltUIMessage[] = [
        {
          id: messageId2,
          role: 'assistant',
          parts: [{ type: 'text', text: 'Second message' }],
        },
      ]

      await saveMessagesWithContextUpdate(threadId, messages)

      const savedMessages = await db.select().from(chatMessagesTable).where(eq(chatMessagesTable.id, messageId2))
      expect(savedMessages).toHaveLength(1)
      expect(savedMessages[0]?.parentId).toBe(messageId1)
    })

    it('should chain multiple messages in batch correctly', async () => {
      const threadId = uuidv7()
      const existingMessageId = uuidv7()
      const messageId1 = uuidv7()
      const messageId2 = uuidv7()
      const messageId3 = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      // Insert existing message
      await db.insert(chatMessagesTable).values({
        id: existingMessageId,
        chatThreadId: threadId,
        role: 'user',
        content: 'Existing message',
        parentId: null,
      })

      const messages: ThunderboltUIMessage[] = [
        {
          id: messageId1,
          role: 'assistant',
          parts: [{ type: 'text', text: 'Message 1' }],
        },
        {
          id: messageId2,
          role: 'user',
          parts: [{ type: 'text', text: 'Message 2' }],
        },
        {
          id: messageId3,
          role: 'assistant',
          parts: [{ type: 'text', text: 'Message 3' }],
        },
      ]

      await saveMessagesWithContextUpdate(threadId, messages)

      const allMessages = await db
        .select()
        .from(chatMessagesTable)
        .where(eq(chatMessagesTable.chatThreadId, threadId))
        .orderBy(chatMessagesTable.id)

      expect(allMessages).toHaveLength(4)

      // First new message should point to existing message
      const msg1 = allMessages.find((m) => m.id === messageId1)
      expect(msg1?.parentId).toBe(existingMessageId)

      // Second new message should point to first new message
      const msg2 = allMessages.find((m) => m.id === messageId2)
      expect(msg2?.parentId).toBe(messageId1)

      // Third new message should point to second new message
      const msg3 = allMessages.find((m) => m.id === messageId3)
      expect(msg3?.parentId).toBe(messageId2)
    })

    it('should update context size from message metadata', async () => {
      const threadId = uuidv7()
      const messageId = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      const messages: ThunderboltUIMessage[] = [
        {
          id: messageId,
          role: 'assistant',
          parts: [{ type: 'text', text: 'Response' }],
          metadata: {
            usage: {
              inputTokens: 100,
              outputTokens: 200,
              totalTokens: 300,
            },
          },
        },
      ]

      await saveMessagesWithContextUpdate(threadId, messages)

      const thread = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, threadId)).get()
      expect(thread?.contextSize).toBe(300)
    })
  })

  describe('cascade delete with parent_id', () => {
    it('should delete child messages when parent is deleted', async () => {
      const threadId = uuidv7()
      const parentMessageId = uuidv7()
      const childMessageId = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      await db.insert(chatMessagesTable).values([
        {
          id: parentMessageId,
          chatThreadId: threadId,
          role: 'user',
          content: 'Parent message',
          parentId: null,
        },
        {
          id: childMessageId,
          chatThreadId: threadId,
          role: 'assistant',
          content: 'Child message',
          parentId: parentMessageId,
        },
      ])

      // Soft delete parent message and descendants (DAL cascade)
      await deleteChatMessageAndDescendants(parentMessageId)

      // No messages visible (soft-deleted)
      const messages = await getChatMessages(threadId)
      expect(messages).toHaveLength(0)
    })

    it('should delete entire chain when root message is deleted', async () => {
      const threadId = uuidv7()
      const msg1Id = uuidv7()
      const msg2Id = uuidv7()
      const msg3Id = uuidv7()
      const msg4Id = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      // Create a chain: msg1 -> msg2 -> msg3 -> msg4
      await db.insert(chatMessagesTable).values([
        {
          id: msg1Id,
          chatThreadId: threadId,
          role: 'user',
          content: 'Message 1',
          parentId: null,
        },
        {
          id: msg2Id,
          chatThreadId: threadId,
          role: 'assistant',
          content: 'Message 2',
          parentId: msg1Id,
        },
        {
          id: msg3Id,
          chatThreadId: threadId,
          role: 'user',
          content: 'Message 3',
          parentId: msg2Id,
        },
        {
          id: msg4Id,
          chatThreadId: threadId,
          role: 'assistant',
          content: 'Message 4',
          parentId: msg3Id,
        },
      ])

      // Soft delete root message and descendants (DAL cascade)
      await deleteChatMessageAndDescendants(msg1Id)

      // No messages visible (soft-deleted)
      const messages = await getChatMessages(threadId)
      expect(messages).toHaveLength(0)
    })

    it('should delete only descendant branch when deleting middle message', async () => {
      const threadId = uuidv7()
      const msg1Id = uuidv7()
      const msg2Id = uuidv7()
      const msg3Id = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      // Create chain: msg1 -> msg2 -> msg3
      await db.insert(chatMessagesTable).values([
        {
          id: msg1Id,
          chatThreadId: threadId,
          role: 'user',
          content: 'Message 1',
          parentId: null,
        },
        {
          id: msg2Id,
          chatThreadId: threadId,
          role: 'assistant',
          content: 'Message 2',
          parentId: msg1Id,
        },
        {
          id: msg3Id,
          chatThreadId: threadId,
          role: 'user',
          content: 'Message 3',
          parentId: msg2Id,
        },
      ])

      // Soft delete middle message and its descendants (DAL cascade)
      await deleteChatMessageAndDescendants(msg2Id)

      // Only msg1 visible (msg2 and msg3 soft-deleted)
      const messages = await getChatMessages(threadId)
      expect(messages).toHaveLength(1)
      expect(messages[0]?.id).toBe(msg1Id)
    })
  })
})
