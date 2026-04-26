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
 * Citation source backed by a Haystack document rather than a web URL.
 */
export type DocumentCitationSource = CitationSource & {
  documentMeta: {
    fileId: string
    fileName: string
    pageNumber?: number
  }
}

/** Type guard for document-backed citations (Haystack documents vs web URLs). */
export const isDocumentCitation = (source: CitationSource): source is DocumentCitationSource =>
  'documentMeta' in source && !!(source as DocumentCitationSource).documentMeta

/**
 * Map of citation placeholder indices to their decoded sources.
 * Used to replace {{CITE:N}} placeholders with inline CitationBadge components.
 */
export type CitationMap = Map<number, CitationSource[]>

/**
 * Build a sideview ID for a document citation.
 * Format: "fileId:fileName" or "fileId:fileName:pageNumber"
 */
export const buildDocumentSideviewId = (meta: { fileId: string; fileName: string; pageNumber?: number }): string => {
  const base = `${meta.fileId}:${meta.fileName}`
  return meta.pageNumber != null ? `${base}:${meta.pageNumber}` : base
}

/**
 * Parse a document sideview ID back into its parts.
 */
export const parseDocumentSideviewId = (id: string): { fileId: string; fileName: string; pageNumber?: number } => {
  const parts = id.split(':')

  // Check if last part is a positive integer (page number)
  const lastPart = parts[parts.length - 1]
  const pageNumber = /^\d+$/.test(lastPart) ? parseInt(lastPart, 10) : undefined

  if (pageNumber !== undefined && parts.length >= 3) {
    return {
      fileId: parts[0],
      fileName: parts.slice(1, -1).join(':'),
      pageNumber,
    }
  }

  return {
    fileId: parts[0],
    fileName: parts.slice(1).join(':'),
  }
}
