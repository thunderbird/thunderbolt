/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ChatMessage, UIMessageMetadata } from '@/types'
import type { UIMessage } from 'ai'
import { clsx, type ClassValue } from 'clsx'
import dayjs from 'dayjs'
import { getTableConfig, type SQLiteColumn, type SQLiteTableWithColumns } from 'drizzle-orm/sqlite-core'
import { twMerge } from 'tailwind-merge'
import {
  type CamelCasedProperties,
  type CamelCasedPropertiesDeep,
  type SnakeCasedProperties,
  type SnakeCasedPropertiesDeep,
} from 'type-fest'

export const cn = (...inputs: ClassValue[]) => {
  return twMerge(clsx(inputs))
}

export const uuidv7ToDate = (uuid: string) => {
  return new Date(parseInt(uuid.slice(0, 8), 16) * 1000)
}

export const convertDbChatMessageToUIMessage = (message: ChatMessage): UIMessage => {
  return {
    id: message.id,
    parts: message.parts ?? [],
    role: message.role,
    metadata: message.metadata ?? {},
  }
}

export const convertUIMessageToDbChatMessage = (
  message: UIMessage,
  chatThreadId: string,
  parentId?: string | null,
): ChatMessage => {
  const metadata = message.metadata as UIMessageMetadata | undefined

  return {
    id: message.id,
    parts: message.parts || [],
    role: message.role,
    content: message.parts.map((part) => (part.type === 'text' ? part.text : '')).join(''),
    chatThreadId,
    modelId: metadata?.modelId ?? null,
    parentId: parentId ?? null,
    cache: null, // Cache is populated lazily by enrichment hooks
    metadata: metadata ?? null,
    deletedAt: null,
    userId: null,
  }
}

export const snakeCased = (str: string): string => {
  return str.replace(/([A-Z])/g, (match) => `_${match.toLowerCase()}`)
}

export const snakeCasedProperties = <T extends Record<string, any>>(obj: T): SnakeCasedProperties<T> => {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return obj as any
  }

  const result: Record<string, any> = {}

  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const snakeKey = snakeCased(key)
      const value = obj[key]

      // Recursively convert nested objects
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        result[snakeKey] = snakeCasedProperties(value)
      } else if (Array.isArray(value)) {
        // Handle arrays by mapping each item
        result[snakeKey] = value.map((item: any) =>
          typeof item === 'object' && item !== null ? snakeCasedProperties(item) : item,
        )
      } else {
        result[snakeKey] = value
      }
    }
  }

  return result as SnakeCasedProperties<T>
}

export const snakeCasedPropertiesDeep = <T extends Record<string, any>>(obj: T): SnakeCasedPropertiesDeep<T> => {
  if (!obj || typeof obj !== 'object') {
    return obj as any
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => snakeCasedPropertiesDeep(item)) as any
  }

  const result: Record<string, any> = {}

  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const snakeKey = snakeCased(key)
      const value = obj[key]

      result[snakeKey] = snakeCasedPropertiesDeep(value)
    }
  }

  return result as SnakeCasedPropertiesDeep<T>
}

export const camelCased = (str: string): string => {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
}

export const camelCasedProperties = <T extends Record<string, any>>(obj: T): CamelCasedProperties<T> => {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return obj as any
  }

  const result: Record<string, any> = {}

  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const camelKey = camelCased(key)
      const value = obj[key]

      // Recursively convert nested objects
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        result[camelKey] = camelCasedProperties(value)
      } else if (Array.isArray(value)) {
        // Handle arrays by mapping each item
        result[camelKey] = value.map((item: any) =>
          typeof item === 'object' && item !== null ? camelCasedProperties(item) : item,
        )
      } else {
        result[camelKey] = value
      }
    }
  }

  return result as CamelCasedProperties<T>
}

export const camelCasedPropertiesDeep = <T extends Record<string, any>>(obj: T): CamelCasedPropertiesDeep<T> => {
  if (!obj || typeof obj !== 'object') {
    return obj as any
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => camelCasedPropertiesDeep(item)) as any
  }

  const result: Record<string, any> = {}

  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const camelKey = camelCased(key)
      const value = obj[key]

      result[camelKey] = camelCasedPropertiesDeep(value)
    }
  }

  return result as CamelCasedPropertiesDeep<T>
}

/** Current UTC datetime as ISO 8601 string (e.g. for deletedAt). */
export const nowIso = (): string => new Date().toISOString()

/**
 * Format a date for display. Accepts Unix ms, or ISO 8601 datetime string.
 */
export const formatDate = (value: number | string): string => {
  const d = dayjs(value)
  const now = dayjs()

  if (d.isSame(now, 'day')) {
    return d.format('HH:mm')
  }

  if (d.isSame(now, 'year')) {
    return d.format('MMM D')
  }

  return d.format('MMM D, YYYY')
}

/**
 * Format large numbers with k/M/B abbreviations using Intl.NumberFormat
 * @param num The number to format
 * @returns Formatted string like "256K" or "1.2M"
 */
export const formatNumber = (num: number): string => {
  const formatter = new Intl.NumberFormat('en', {
    notation: 'compact',
    maximumFractionDigits: 1,
  })

  return formatter.format(num)
}

/**
 * Split UI part types like "tool-read_file" into [type, name]
 */
export const splitPartType = (type: string): [string, string] => {
  const dashIndex = type.indexOf('-')
  if (dashIndex === -1) {
    return [type, 'unknown']
  }
  return [type.slice(0, dashIndex), type.slice(dashIndex + 1)]
}

/**
 * Compute a simple hash from an array of values
 * Uses a basic hash algorithm suitable for change detection
 */
export const hashValues = (values: (string | number | null | undefined)[]): string => {
  const str = values.join('|')
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash // Convert to 32-bit integer
  }
  return hash.toString(36)
}

/**
 * Format tool output as a string, handling both string and object outputs
 * @param output The output from a tool invocation
 * @returns String representation of the output
 */
export const formatToolOutput = (output: unknown): string => {
  if (typeof output === 'string') {
    return output
  }
  return JSON.stringify(output, null, 2)
}

export const formatDuration = (ms: number): string => {
  const seconds = ms / 1000
  if (seconds < 1) {
    return `${Math.round(ms)}ms`
  }
  return `${seconds.toFixed(1)}s`
}

/**
 * Computes the wall-clock duration covered by a set of potentially overlapping time intervals.
 * Uses interval union: sorts by start time, merges overlapping intervals, sums their lengths.
 * Returns the total in milliseconds.
 */
export const computeWallClockTime = (intervals: Array<{ start: number; end: number }>): number => {
  if (intervals.length === 0) {
    return 0
  }

  const sorted = [...intervals].sort((a, b) => a.start - b.start)
  let totalMs = 0
  let currentStart = sorted[0].start
  let currentEnd = sorted[0].end

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start <= currentEnd) {
      currentEnd = Math.max(currentEnd, sorted[i].end)
    } else {
      totalMs += currentEnd - currentStart
      currentStart = sorted[i].start
      currentEnd = sorted[i].end
    }
  }
  totalMs += currentEnd - currentStart

  return totalMs
}

/**
 * Check if a URL points to localhost
 */
export const isLocalhostUrl = (url: string | null): boolean => {
  if (!url) {
    return false
  }
  return url.startsWith('http://localhost')
}

/**
 * Validates email format using a practical regex pattern.
 * Checks for: local-part@domain.tld structure with basic character validation.
 */
export const isValidEmailFormat = (email: string): boolean => {
  const emailRegex =
    /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/
  return emailRegex.test(email)
}

/**
 * Maximum content length for LLM context (16K chars ≈ 4K tokens)
 * Used by fetch_content, Google Drive, and OneDrive file retrieval
 */
export const llmContentCharLimit = 16_000

/**
 * Truncate text to prevent context overflow in LLM requests
 */
export const truncateText = (text: string, maxLength = 4000): string => {
  if (text.length <= maxLength) {
    return text
  }
  return text.substring(0, maxLength) + '...[truncated]'
}

/**
 * Returns an object with nullable columns set to null for soft-delete data scrubbing.
 * Automatically detects and skips primary keys, foreign keys, unique columns, and deletedAt.
 *
 * @param table - Drizzle SQLite table definition
 * @returns Object with nullable columns set to null for data privacy
 *
 * @example
 * await db.update(usersTable)
 *   .set({ ...clearNullableColumns(usersTable), deletedAt: nowIso() })
 *   .where(eq(usersTable.id, userId))
 */
export const clearNullableColumns = <T extends SQLiteTableWithColumns<any>>(table: T): Partial<T['$inferInsert']> => {
  const cleared: Record<string, null> = {}

  const tableConfig = getTableConfig(table)

  // Get all foreign key column names
  const fkColumnNames = new Set(tableConfig.foreignKeys.flatMap((fk) => fk.reference().columns.map((col) => col.name)))

  // Get all primary key column names from composite primaryKey declarations
  const pkColumnNames = new Set(tableConfig.primaryKeys.flatMap((pk) => pk.columns.map((col) => col.name)))

  // Get all unique constraint column names from composite unique declarations
  const uniqueColumnNames = new Set(tableConfig.uniqueConstraints.flatMap((uc) => uc.columns.map((col) => col.name)))

  for (const [name, column] of Object.entries(table) as [string, SQLiteColumn][]) {
    if (!column?.dataType) {
      continue
    }
    // Skip deletedAt (handled separately by caller with new datetime)
    if (name === 'deletedAt') {
      continue
    }
    // although the BE ensures that the userId is always present, we gonna keep it for now for backwards compatibility
    if (name === 'userId') {
      continue
    }
    // Skip primary key columns (single-column via .primaryKey() or composite via primaryKey())
    if (column.primary || pkColumnNames.has(column.name)) {
      continue
    }
    // Skip foreign key columns (to maintain referential integrity)
    if (fkColumnNames.has(column.name)) {
      continue
    }
    // Skip unique columns (functional identifiers)
    if (column.isUnique || uniqueColumnNames.has(column.name)) {
      continue
    }
    // Skip required (not null) columns
    if (column.notNull) {
      continue
    }

    cleared[name] = null
  }

  return cleared as Partial<T['$inferInsert']>
}
