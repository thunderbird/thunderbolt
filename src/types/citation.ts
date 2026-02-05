/**
 * Type definitions for citation feature
 *
 * These types are shared between citation-ui and source-cards modules.
 * DO NOT modify without coordinating with both IMPLEMENTER-1 and IMPLEMENTER-2.
 */

/**
 * Represents a single source in a citation
 */
export type CitationSource = {
  /** Unique identifier for the source */
  id: string
  /** Title of the source article/page */
  title: string
  /** Full URL to the source */
  url: string
  /** Display name of the website/publisher (e.g., "Nature", "Wikipedia") */
  siteName?: string
  /** URL to the source's favicon */
  favicon?: string
  /** Whether this is the primary source (first/most relevant) */
  isPrimary?: boolean
}

/**
 * Widget data structure for citation widgets
 * Used by the widget parser to pass data to CitationBadge component
 */
export type CitationWidget = {
  widget: 'citation'
  args: {
    /** JSON-encoded array of CitationSource objects */
    sources: string
    /** Optional: display inline without additional styling */
    inline?: string
  }
}

/**
 * Parsed citation data after JSON deserialization
 */
export type ParsedCitationData = {
  sources: CitationSource[]
  inline?: boolean
}
