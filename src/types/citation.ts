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
  /** When true, this is a placeholder badge still loading (not clickable) */
  isLoading?: boolean
  /** When present, this citation points to a Haystack document instead of a URL */
  documentMeta?: {
    fileId: string
    fileName: string
    pageNumber?: number
  }
}

/**
 * Map of citation placeholder indices to their decoded sources.
 * Used to replace {{CITE:N}} placeholders with inline CitationBadge components.
 */
export type CitationMap = Map<number, CitationSource[]>

/** Builds a colon-delimited sideview identifier from document metadata. */
export const buildDocumentSideviewId = (meta: NonNullable<CitationSource['documentMeta']>): string =>
  meta.pageNumber != null ? `${meta.fileId}:${meta.fileName}:${meta.pageNumber}` : `${meta.fileId}:${meta.fileName}`
