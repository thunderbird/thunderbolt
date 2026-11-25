/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Suspense } from 'react'
import { Loader2 } from 'lucide-react'
import { parseDocumentSideviewId } from '@/types/citation'
import { getFileType } from '@/widgets/document-result/file-type'
import { importWhenReachable } from '@/lib/import-when-reachable'
import { retryableLazy } from './retryable-lazy'
import { ViewerErrorBoundary } from './viewer-error-boundary'
import { LocalViewerLoadFailure, ViewerLoadFailure } from './viewer-load-failure'
import { useSideviewState } from './use-sideview-state'

// Lazy-load the PDF viewer so its react-pdf + pdfjs payload only ships when a
// document sideview is opened. The DOCX and PPTX renderers are dynamically
// imported inside the viewer itself, each for its own file type. Both PDF viewers
// share one loader, so once one has loaded, the other opens without the network.
const pdfSidebarViewerModule = importWhenReachable(() => import('@/widgets/document-result/pdf-sidebar-viewer'))

const pdfSidebarViewer = retryableLazy(async () => ({
  default: (await pdfSidebarViewerModule()).PdfSidebarViewer,
}))

const localPdfSidebarViewer = retryableLazy(async () => ({
  default: (await pdfSidebarViewerModule()).LocalPdfSidebarViewer,
}))

// A chunk apart from react-pdf, so the grid and the Worker that downloads Excelize load only when a workbook opens.
const xlsxPreviewModule = importWhenReachable(() => import('@/components/xlsx-preview'))

const localXlsxSidebarViewer = retryableLazy(async () => ({
  default: (await xlsxPreviewModule()).LocalXlsxSidebarViewer,
}))

const loadingFallback = (
  <div className="flex h-full items-center justify-center">
    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
  </div>
)

/**
 * Renders the active sideview based on `sideviewType`. New sideview kinds are
 * added by extending this switch.
 */
export const Sideview = () => {
  // Try again bumps `attempt`. The new key remounts the boundary, and the viewer's code is imported again.
  const { sideviewType, sideviewId, attempt, retry } = useSideviewState()

  // Each viewer's error boundary is keyed by its file id, so switching files starts fresh: a failed save, a pending
  // one, or a viewer that did not load never carries over to the next file. Not by page, which only scrolls the same
  // file. When a viewer's chunk does not load, as on a broken network, the panel shows a notice with Try again and
  // Download. Closing the panel and opening the file again also retries, because the side view mounts again.
  if (sideviewType === 'document' && sideviewId) {
    const { fileId, fileName, pageNumber } = parseDocumentSideviewId(sideviewId)
    const PdfSidebarViewer = pdfSidebarViewer()
    return (
      <ViewerErrorBoundary
        key={`${fileId}:${attempt}`}
        fallback={<ViewerLoadFailure fileId={fileId} fileName={fileName} onRetry={retry} />}
      >
        <Suspense fallback={loadingFallback}>
          <PdfSidebarViewer fileId={fileId} fileName={fileName} initialPage={pageNumber} />
        </Suspense>
      </ViewerErrorBoundary>
    )
  }

  // Locally-uploaded attachment — the `fileId` slot carries the IndexedDB localFileId.
  if (sideviewType === 'local-file' && sideviewId) {
    const { fileId, fileName, pageNumber } = parseDocumentSideviewId(sideviewId)
    const LocalXlsxSidebarViewer = localXlsxSidebarViewer()
    const LocalPdfSidebarViewer = localPdfSidebarViewer()
    return (
      <ViewerErrorBoundary
        key={`${fileId}:${attempt}`}
        fallback={<LocalViewerLoadFailure fileId={fileId} fileName={fileName} onRetry={retry} />}
      >
        <Suspense fallback={loadingFallback}>
          {getFileType(fileName) === 'xlsx' ? (
            <LocalXlsxSidebarViewer localFileId={fileId} fileName={fileName} />
          ) : (
            <LocalPdfSidebarViewer localFileId={fileId} fileName={fileName} initialPage={pageNumber} />
          )}
        </Suspense>
      </ViewerErrorBoundary>
    )
  }

  return null
}
