/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useOnScreen } from '@/hooks/use-on-screen'
import { lazy, Suspense, useRef } from 'react'

const PdfThumbnail = lazy(() => import('./pdf-thumbnail'))

/** Start PDF decoding near the viewport and retain it when the card scrolls away. */
export const DeferredPdfThumbnail = ({ localFileId }: { localFileId: string }) => {
  const ref = useRef<HTMLDivElement>(null)
  const isOnScreen = useOnScreen(ref)

  return (
    <div ref={ref} className="pointer-events-none absolute inset-0">
      {isOnScreen && (
        <Suspense fallback={null}>
          <PdfThumbnail localFileId={localFileId} />
        </Suspense>
      )}
    </div>
  )
}
