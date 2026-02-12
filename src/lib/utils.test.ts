import type { UIMessage } from 'ai'
import { describe, expect, it } from 'bun:test'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { v7 as uuidv7 } from 'uuid'
import { clearNullableColumns, convertUIMessageToDbChatMessage, formatNumber, hashValues, splitPartType } from './utils'

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

  describe('splitPartType', () => {
    it('should split type with dash into [type, name]', () => {
      expect(splitPartType('tool-read_file')).toEqual(['tool', 'read_file'])
      expect(splitPartType('call-function')).toEqual(['call', 'function'])
    })

    it('should return [type, "unknown"] when no dash present', () => {
      expect(splitPartType('text')).toEqual(['text', 'unknown'])
      expect(splitPartType('user')).toEqual(['user', 'unknown'])
    })

    it('should split at first dash only when multiple dashes present', () => {
      expect(splitPartType('tool-call-function')).toEqual(['tool', 'call-function'])
      expect(splitPartType('a-b-c-d')).toEqual(['a', 'b-c-d'])
    })

    it('should handle edge cases', () => {
      expect(splitPartType('')).toEqual(['', 'unknown'])
      expect(splitPartType('-')).toEqual(['', ''])
      expect(splitPartType('-suffix')).toEqual(['', 'suffix'])
      expect(splitPartType('prefix-')).toEqual(['prefix', ''])
    })
  })

  describe('hashValues', () => {
    it('should produce consistent hashes for same input', () => {
      const hash1 = hashValues(['a', 'b', 'c'])
      const hash2 = hashValues(['a', 'b', 'c'])
      expect(hash1).toBe(hash2)
    })

    it('should produce different hashes for different inputs', () => {
      const hash1 = hashValues(['a', 'b', 'c'])
      const hash2 = hashValues(['a', 'b', 'd'])
      const hash3 = hashValues(['x', 'y', 'z'])
      expect(hash1).not.toBe(hash2)
      expect(hash1).not.toBe(hash3)
      expect(hash2).not.toBe(hash3)
    })

    it('should handle various data types', () => {
      const hash1 = hashValues(['string', 42, null, undefined])
      const hash2 = hashValues(['string', 42, null, undefined])
      expect(hash1).toBe(hash2)
    })

    it('should produce hash for empty array', () => {
      const hash = hashValues([])
      expect(typeof hash).toBe('string')
      expect(hash.length).toBeGreaterThan(0)
    })

    it('should produce hash for single value', () => {
      const hash = hashValues(['single'])
      expect(typeof hash).toBe('string')
      expect(hash.length).toBeGreaterThan(0)
    })

    it('should produce different hashes for different orderings', () => {
      const hash1 = hashValues(['a', 'b', 'c'])
      const hash2 = hashValues(['c', 'b', 'a'])
      expect(hash1).not.toBe(hash2)
    })

    it('should handle numbers correctly', () => {
      const hash1 = hashValues([1, 2, 3])
      const hash2 = hashValues([1, 2, 3])
      const hash3 = hashValues([3, 2, 1])
      expect(hash1).toBe(hash2)
      expect(hash1).not.toBe(hash3)
    })
  })

  describe('clearNullableColumns', () => {
    it('should set nullable columns to null', () => {
      const testTable = sqliteTable('test', {
        id: text('id').primaryKey().notNull(),
        description: text('description'),
        age: integer('age'),
      })

      const result = clearNullableColumns(testTable)

      expect(result).toEqual({
        description: null,
        age: null,
      })
    })

    it('should skip required text columns', () => {
      const testTable = sqliteTable('test', {
        id: text('id').primaryKey().notNull(),
        name: text('name').notNull(),
        title: text('title').notNull(),
      })

      const result = clearNullableColumns(testTable)

      expect(result).toEqual({})
    })

    it('should skip required number columns', () => {
      const testTable = sqliteTable('test', {
        id: text('id').primaryKey().notNull(),
        count: integer('count').notNull(),
        score: integer('score').notNull(),
      })

      const result = clearNullableColumns(testTable)

      expect(result).toEqual({})
    })

    it('should only set nullable columns to null in mixed types', () => {
      const testTable = sqliteTable('test', {
        id: text('id').primaryKey().notNull(),
        name: text('name').notNull(),
        description: text('description'),
        count: integer('count').notNull(),
        score: integer('score'),
      })

      const result = clearNullableColumns(testTable)

      expect(result).toEqual({
        description: null,
        score: null,
      })
    })

    it('should skip id column even if nullable', () => {
      const testTable = sqliteTable('test', {
        id: text('id').primaryKey(),
        name: text('name'),
      })

      const result = clearNullableColumns(testTable)

      expect(result).toEqual({ name: null })
      expect(result).not.toHaveProperty('id')
    })

    it('should skip primary key column regardless of name (like settings.key)', () => {
      const testTable = sqliteTable('test', {
        key: text('key').primaryKey(),
        value: text('value'),
      })

      const result = clearNullableColumns(testTable)

      expect(result).toEqual({ value: null })
      expect(result).not.toHaveProperty('key')
    })

    it('should skip unique columns', () => {
      const testTable = sqliteTable('test', {
        id: text('id').primaryKey().notNull(),
        email: text('email').unique(),
        name: text('name'),
      })

      const result = clearNullableColumns(testTable)

      expect(result).toEqual({ name: null })
      expect(result).not.toHaveProperty('email')
    })

    it('should skip deletedAt column', () => {
      const testTable = sqliteTable('test', {
        id: text('id').primaryKey().notNull(),
        name: text('name'),
        deletedAt: text('deleted_at'),
      })

      const result = clearNullableColumns(testTable)

      expect(result).toEqual({ name: null })
      expect(result).not.toHaveProperty('deletedAt')
    })

    it('should skip userId column (required for PowerSync sync rules)', () => {
      const testTable = sqliteTable('test', {
        id: text('id').primaryKey().notNull(),
        name: text('name'),
        userId: text('user_id'),
      })

      const result = clearNullableColumns(testTable)

      expect(result).toEqual({ name: null })
      expect(result).not.toHaveProperty('userId')
    })

    it('should skip foreign key columns', () => {
      const parentTable = sqliteTable('parent', {
        id: text('id').primaryKey().notNull(),
      })

      const childTable = sqliteTable('child', {
        id: text('id').primaryKey().notNull(),
        parentId: text('parent_id').references(() => parentTable.id),
        name: text('name'),
      })

      const result = clearNullableColumns(childTable)

      expect(result).toEqual({ name: null })
      expect(result).not.toHaveProperty('parentId')
    })

    it('should skip required foreign key columns', () => {
      const parentTable = sqliteTable('parent', {
        id: text('id').primaryKey().notNull(),
      })

      const childTable = sqliteTable('child', {
        id: text('id').primaryKey().notNull(),
        parentId: text('parent_id')
          .notNull()
          .references(() => parentTable.id),
        name: text('name').notNull(),
      })

      const result = clearNullableColumns(childTable)

      expect(result).toEqual({})
      expect(result).not.toHaveProperty('parentId')
    })
  })
})
