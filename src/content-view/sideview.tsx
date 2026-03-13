import { PdfSidebarViewer } from '@/widgets/document-result/pdf-sidebar-viewer'
import { EmailThreadView } from './thread'
import { useQuery } from '@tanstack/react-query'
import { useSideview } from './context'

/**
 * Parses a document sideview ID in the format "fileId:fileName"
 */
const parseDocumentSideviewId = (sideviewId: string) => {
  const colonIndex = sideviewId.indexOf(':')
  if (colonIndex === -1) return { fileId: sideviewId, fileName: 'document.pdf' }
  return {
    fileId: sideviewId.slice(0, colonIndex),
    fileName: sideviewId.slice(colonIndex + 1),
  }
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
      if (!sideviewId) return null
      const { fileId, fileName } = parseDocumentSideviewId(sideviewId)
      return <PdfSidebarViewer fileId={fileId} fileName={fileName} />
    }
    default:
      return <div>Unsupported sideview type</div>
  }
}
