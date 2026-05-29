/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { lazy, Suspense } from 'react'
import { Loader2 } from 'lucide-react'
import { parseDocumentSideviewId } from '@/types/citation'
import { useSideview } from './context'

// Lazy-load the PDF viewer so its react-pdf + pdfjs payload only ships when a
// document sideview is opened. mammoth is dynamically imported inside the
// viewer itself for the DOCX path.
const PdfSidebarViewer = lazy(() =>
  import('@/widgets/document-result/pdf-sidebar-viewer').then((m) => ({ default: m.PdfSidebarViewer })),
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

  if (sideviewType === 'document' && sideviewId) {
    const { fileId, fileName, pageNumber } = parseDocumentSideviewId(sideviewId)
    return (
      <Suspense fallback={loadingFallback}>
        <PdfSidebarViewer fileId={fileId} fileName={fileName} initialPage={pageNumber} />
      </Suspense>
    )
  }

  return null
}
