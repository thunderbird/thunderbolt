/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { lazy, Suspense } from 'react'
import { Loader2 } from 'lucide-react'
import { parseDocumentSideviewId } from '@/types/citation'
import { getFileType } from '@/widgets/document-result/file-type'
import { useSideview } from './context'

// Lazy-load the PDF viewer so its react-pdf + pdfjs payload only ships when a
// document sideview is opened. The DOCX and PPTX renderers are dynamically
// imported inside the viewer itself, each for its own file type.
const PdfSidebarViewer = lazy(() =>
  import('@/widgets/document-result/pdf-sidebar-viewer').then((m) => ({ default: m.PdfSidebarViewer })),
)

const LocalPdfSidebarViewer = lazy(() =>
  import('@/widgets/document-result/pdf-sidebar-viewer').then((m) => ({ default: m.LocalPdfSidebarViewer })),
)

// A chunk apart from react-pdf, so the grid and the Worker that downloads Excelize load only when a workbook opens.
const LocalXlsxSidebarViewer = lazy(() =>
  import('@/components/xlsx-preview').then((m) => ({ default: m.LocalXlsxSidebarViewer })),
)

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
  const { sideviewType, sideviewId } = useSideview()

  // Each viewer is keyed by its file id, so switching files starts fresh: a failed save, or one still pending, for
  // one file never shows on the next. Not by page, which only scrolls the same file.
  if (sideviewType === 'document' && sideviewId) {
    const { fileId, fileName, pageNumber } = parseDocumentSideviewId(sideviewId)
    return (
      <Suspense fallback={loadingFallback}>
        <PdfSidebarViewer key={fileId} fileId={fileId} fileName={fileName} initialPage={pageNumber} />
      </Suspense>
    )
  }

  // Locally-uploaded attachment — the `fileId` slot carries the IndexedDB localFileId.
  if (sideviewType === 'local-file' && sideviewId) {
    const { fileId, fileName, pageNumber } = parseDocumentSideviewId(sideviewId)
    return (
      <Suspense fallback={loadingFallback}>
        {getFileType(fileName) === 'xlsx' ? (
          <LocalXlsxSidebarViewer key={fileId} localFileId={fileId} fileName={fileName} />
        ) : (
          <LocalPdfSidebarViewer key={fileId} localFileId={fileId} fileName={fileName} initialPage={pageNumber} />
        )}
      </Suspense>
    )
  }

  return null
}
