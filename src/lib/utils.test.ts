import type { UIMessage } from 'ai'
import { describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import { convertUIMessageToDbChatMessage, formatNumber } from './utils'

describe('utils', () => {
  describe('formatNumber', () => {
    it('should format numbers below 1000 as-is', () => {
      expect(formatNumber(0)).toBe('0')
      expect(formatNumber(42)).toBe('42')
      expect(formatNumber(999)).toBe('999')
    })

    it('should format thousands with K suffix', () => {
      expect(formatNumber(1000)).toBe('1K')
      expect(formatNumber(1500)).toBe('1.5K')
      expect(formatNumber(256000)).toBe('256K')
      expect(formatNumber(999999)).toBe('1M')
    })

    it('should format millions with M suffix', () => {
      expect(formatNumber(1000000)).toBe('1M')
      expect(formatNumber(1500000)).toBe('1.5M')
      expect(formatNumber(2560000)).toBe('2.6M')
    })

    it('should format billions with B suffix', () => {
      expect(formatNumber(1000000000)).toBe('1B')
      expect(formatNumber(1500000000)).toBe('1.5B')
      expect(formatNumber(2560000000)).toBe('2.6B')
    })

    it('should handle exact values without decimals', () => {
      expect(formatNumber(2000)).toBe('2K')
      expect(formatNumber(5000000)).toBe('5M')
      expect(formatNumber(3000000000)).toBe('3B')
    })
  })

  describe('convertUIMessageToDbChatMessage', () => {
    it('should convert UI message to DB message without parent', () => {
      const threadId = uuidv7()
      const messageId = uuidv7()

      const uiMessage: UIMessage = {
        id: messageId,
        role: 'user',
        parts: [{ type: 'text', text: 'Hello world' }],
      }

      const dbMessage = convertUIMessageToDbChatMessage(uiMessage, threadId)

      expect(dbMessage.id).toBe(messageId)
      expect(dbMessage.chatThreadId).toBe(threadId)
      expect(dbMessage.role).toBe('user')
      expect(dbMessage.content).toBe('Hello world')
      expect(dbMessage.parentId).toBe(null)
    })

    it('should convert UI message to DB message with parent_id', () => {
      const threadId = uuidv7()
      const messageId = uuidv7()
      const parentId = uuidv7()

      const uiMessage: UIMessage = {
        id: messageId,
        role: 'assistant',
        parts: [{ type: 'text', text: 'Response text' }],
      }

      const dbMessage = convertUIMessageToDbChatMessage(uiMessage, threadId, parentId)

      expect(dbMessage.id).toBe(messageId)
      expect(dbMessage.chatThreadId).toBe(threadId)
      expect(dbMessage.role).toBe('assistant')
      expect(dbMessage.content).toBe('Response text')
      expect(dbMessage.parentId).toBe(parentId)
    })

    it('should set parentId to null when explicitly passed null', () => {
      const threadId = uuidv7()
      const messageId = uuidv7()

      const uiMessage: UIMessage = {
        id: messageId,
        role: 'user',
        parts: [{ type: 'text', text: 'First message' }],
      }

      const dbMessage = convertUIMessageToDbChatMessage(uiMessage, threadId, null)

      expect(dbMessage.parentId).toBe(null)
    })

    it('should handle messages with model metadata', () => {
      const threadId = uuidv7()
      const messageId = uuidv7()
      const parentId = uuidv7()
      const modelId = uuidv7()

      const uiMessage: UIMessage = {
        id: messageId,
        role: 'assistant',
        parts: [{ type: 'text', text: 'Response' }],
        metadata: { modelId },
      }

      const dbMessage = convertUIMessageToDbChatMessage(uiMessage, threadId, parentId)

      expect(dbMessage.modelId).toBe(modelId)
      expect(dbMessage.parentId).toBe(parentId)
    })
  })
})
