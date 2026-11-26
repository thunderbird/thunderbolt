/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useIsMobile } from '@/hooks/use-mobile'
import { useViewSize } from '@/hooks/use-view-size'
import { useRef, useState } from 'react'
import { type DocumentSnapshot, fitStyle, pagesZoomToFit } from './snapshot'

/**
 * How a snapshot's pages fit the panel the returned `ref` measures: the reflow style on a phone, the fit style where
 * the browser zooms pages as they are, and otherwise a frame as wide as the pages, scaled down to the panel's width.
 */
export const useSnapshotPagesState = (snapshot: Extract<DocumentSnapshot, { kind: 'pages' }>) => {
  const ref = useRef<HTMLDivElement>(null)
  const view = useViewSize(ref)
  const { isMobile } = useIsMobile()
  const [zoomFits] = useState(pagesZoomToFit)
  const reflowStyle = isMobile ? snapshot.reflowStyle : undefined
  const pagesStyle = reflowStyle ?? (zoomFits ? fitStyle(snapshot.width) : '')
  const scales = !reflowStyle && !zoomFits && view.width > 0 && view.width < snapshot.width
  const scale = scales ? view.width / snapshot.width : 1
  const size =
    scale < 1
      ? { width: snapshot.width, height: view.height / scale, transform: `scale(${scale})` }
      : { width: '100%', height: '100%' }
  // A style after the end of the markup still applies: the parser moves it into the body.
  const srcDoc = snapshot.html + pagesStyle

  return { ref, srcDoc, size }
}
