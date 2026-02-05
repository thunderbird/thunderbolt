import type { CitationSource } from '@/types/citation'

/**
 * Decodes a base64-encoded JSON string into CitationSource[].
 * Returns null if decoding fails or sources are empty.
 */
export const decodeCitationSources = (base64Sources: string): CitationSource[] | null => {
  try {
    const decoded = atob(base64Sources)
    const parsed = JSON.parse(decoded)
    const sources = Array.isArray(parsed) ? (parsed as CitationSource[]) : []
    return sources.length > 0 ? sources : null
  } catch {
    return null
  }
}

/**
 * Validates that a URL uses a safe protocol (http or https).
 * Returns false for javascript:, data:, and other potentially dangerous schemes.
 */
export const isSafeUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}
