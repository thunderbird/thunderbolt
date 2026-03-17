import { PdfSidebarViewer } from '@/widgets/document-result/pdf-sidebar-viewer'
import { EmailThreadView } from './thread'
import { useQuery } from '@tanstack/react-query'
import { useSideview } from './context'

/**
 * Parses a document sideview ID in the format "fileId:fileName" or "fileId:fileName:pageNumber".
 * The last `:` segment is treated as a page number only if it's a positive integer.
 * @internal Exported for testing only
 */
export const parseDocumentSideviewId = (sideviewId: string) => {
  const colonIndex = sideviewId.indexOf(':')
  if (colonIndex === -1) {
    return { fileId: sideviewId, fileName: 'document.pdf', pageNumber: undefined }
  }

  const fileId = sideviewId.slice(0, colonIndex)
  const rest = sideviewId.slice(colonIndex + 1)

  const lastColonIndex = rest.lastIndexOf(':')
  if (lastColonIndex !== -1) {
    const maybePage = rest.slice(lastColonIndex + 1)
    const pageNum = parseInt(maybePage, 10)
    if (!isNaN(pageNum) && pageNum > 0 && String(pageNum) === maybePage) {
      return {
        fileId,
        fileName: rest.slice(0, lastColonIndex),
        pageNumber: pageNum,
      }
    }
  }

  return { fileId, fileName: rest, pageNumber: undefined }
}

/**
 * Sideview component - displays content based on sideview type
 */
export const Sideview = () => {
  const { sideviewId, sideviewType } = useSideview()

  const { data: _object } = useQuery({
    queryKey: ['sideview', sideviewType, sideviewId],
    queryFn: async () => {
      if (!sideviewId || !sideviewType) {
        return null
      }

      switch (sideviewType) {
        case 'message':
          // @todo re-implement this
          return null
        case 'thread':
          // @todo re-implement this
          return null
        default:
          return null
      }
    },
    enabled: !!sideviewId && !!sideviewType,
  })

  switch (sideviewType) {
    case 'message':
      return <EmailThreadView />
    case 'thread':
      return <EmailThreadView />
    case 'document': {
      if (!sideviewId) {
        return null
      }
      const { fileId, fileName, pageNumber } = parseDocumentSideviewId(sideviewId)
      return <PdfSidebarViewer fileId={fileId} fileName={fileName} initialPage={pageNumber} />
    }
    default:
      return <div>Unsupported sideview type</div>
  }
}
