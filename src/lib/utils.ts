import type { ChatMessage, UIMessageMetadata } from '@/types'
import type { UIMessage } from 'ai'
import { clsx, type ClassValue } from 'clsx'
import dayjs from 'dayjs'
import { twMerge } from 'tailwind-merge'
import {
  type CamelCasedProperties,
  type CamelCasedPropertiesDeep,
  type SnakeCasedProperties,
  type SnakeCasedPropertiesDeep,
} from 'type-fest'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function uuidv7ToDate(uuid: string) {
  return new Date(parseInt(uuid.slice(0, 8), 16) * 1000)
}

export function convertDbChatMessageToUIMessage(message: ChatMessage): UIMessage {
  return {
    id: message.id,
    parts: message.parts ?? [],
    role: message.role,
    metadata: {},
  }
}

export function convertUIMessageToDbChatMessage(
  message: UIMessage,
  chatThreadId: string,
  parentId?: string | null,
): ChatMessage {
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
  }
}

export function snakeCased(str: string): string {
  return str.replace(/([A-Z])/g, (match) => `_${match.toLowerCase()}`)
}

export function snakeCasedProperties<T extends Record<string, any>>(obj: T): SnakeCasedProperties<T> {
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

export function snakeCasedPropertiesDeep<T extends Record<string, any>>(obj: T): SnakeCasedPropertiesDeep<T> {
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

export function camelCased(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
}

export function camelCasedProperties<T extends Record<string, any>>(obj: T): CamelCasedProperties<T> {
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

export function camelCasedPropertiesDeep<T extends Record<string, any>>(obj: T): CamelCasedPropertiesDeep<T> {
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

export function formatDate(timestamp: number): string {
  const d = dayjs(timestamp)
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
