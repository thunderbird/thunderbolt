import type { CitationSource } from '@/types/citation'

/**
 * Parses a JSON string (raw or base64-encoded) into CitationSource[].
 * Tries raw JSON first, then base64 decode as fallback for backward compatibility.
 * Returns null if parsing fails or sources are empty.
 */
export const decodeCitationSources = (sourcesStr: string): CitationSource[] | null => {
  const parseJson = (json: string): CitationSource[] | null => {
    try {
      const parsed = JSON.parse(json)
      const sources = Array.isArray(parsed) ? (parsed as CitationSource[]) : null
      return sources && sources.length > 0 ? sources : null
    } catch {
      return null
    }
  }

  const trimmed = sourcesStr.trim()
  if (trimmed.startsWith('[')) return parseJson(trimmed)

  // Fallback: base64-encoded JSON (backward compatibility)
  try {
    return parseJson(atob(trimmed))
  } catch {
    return null
  }
}
