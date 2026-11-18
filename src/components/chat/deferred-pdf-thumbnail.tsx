/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { retryableLazy } from '@/content-view/retryable-lazy'
import { ViewerErrorBoundary } from '@/content-view/viewer-error-boundary'
import { useOnScreen } from '@/hooks/use-on-screen'
import { Suspense, useRef } from 'react'

const pdfThumbnail = retryableLazy(() => import('./pdf-thumbnail'))

/** Start PDF decoding near the viewport and retain it when the card scrolls away. */
export const DeferredPdfThumbnail = ({ localFileId }: { localFileId: string }) => {
  const ref = useRef<HTMLDivElement>(null)
  const isOnScreen = useOnScreen(ref)
  const PdfThumbnail = pdfThumbnail()

  return (
    <div ref={ref} className="pointer-events-none absolute inset-0">
      {isOnScreen && (
        // When its code does not load, the card keeps its icon, and the next time it mounts it tries again.
        <ViewerErrorBoundary fallback={null}>
          <Suspense fallback={null}>
            <PdfThumbnail localFileId={localFileId} />
          </Suspense>
        </ViewerErrorBoundary>
      )}
    </div>
  )
}
