import { CitationBadge } from '@/components/chat/citation-badge'
import type { CitationSource } from '@/types/citation'

type CitationWidgetProps = {
  sources: string
  messageId: string
}

/**
 * Citation widget component - wrapper that receives parsed widget data
 * and renders CitationBadge with deserialized sources.
 */
export const CitationWidgetComponent = ({ sources: sourcesJson }: CitationWidgetProps) => {
  // Decode base64 and parse JSON sources string to CitationSource[]
  let sources: CitationSource[] = []
  try {
    // Base64 decode first to handle HTML entity encoding issues
    const decoded = atob(sourcesJson)
    const parsed = JSON.parse(decoded)
    // Ensure we have an array
    sources = Array.isArray(parsed) ? parsed : []
  } catch (error) {
    console.error('Failed to parse citation sources:', error)
    return null
  }

  // Return null if no valid sources
  if (sources.length === 0) {
    return null
  }

  return <CitationBadge sources={sources} />
}

export { CitationWidgetComponent as Component }
