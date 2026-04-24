import { useSideview } from './context'
import { parseDocumentSideviewId } from '@/types/citation'
import { lazy, Suspense } from 'react'
import { Loader2 } from 'lucide-react'

const PdfSidebarViewer = lazy(() =>
  import('@/widgets/document-result/pdf-sidebar-viewer').then((m) => ({ default: m.PdfSidebarViewer })),
)

/**
 * Sideview component - displays content based on sideview type
 */
export const Sideview = () => {
  const { sideviewId, sideviewType } = useSideview()

  switch (sideviewType) {
    case 'document': {
      if (!sideviewId) {
        return null
      }
      const { fileId, fileName, pageNumber } = parseDocumentSideviewId(sideviewId)
      return (
        <Suspense
          fallback={
            <div className="flex flex-1 items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          }
        >
          <PdfSidebarViewer fileId={fileId} fileName={fileName} initialPage={pageNumber} />
        </Suspense>
      )
    }
    default:
      return null
  }
}
