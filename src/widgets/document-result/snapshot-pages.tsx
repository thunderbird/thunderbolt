/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useIsMobile } from '@/hooks/use-mobile'
import { useViewSize } from '@/hooks/use-view-size'
import { useRef, useState } from 'react'
import { type DocumentSnapshot, fitStyle, pagesZoomToFit } from './snapshot'

type SnapshotPagesProps = {
  title: string
  snapshot: Extract<DocumentSnapshot, { kind: 'pages' }>
}

/**
 * A document's pages or a deck's slides in a frame with `sandbox=""` that fills the panel and scrolls them itself.
 * Pages wider than the panel scale down to its width with the fit style; in a browser where that style does not draw
 * them as they are, such as Safari, the frame keeps the pages' width and is drawn smaller. On a phone, pages that
 * reflow take its width instead, so their text stays readable.
 */
export const SnapshotPages = ({ title, snapshot }: SnapshotPagesProps) => {
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
  return (
    <div ref={ref} className="relative min-h-0 flex-1 overflow-hidden">
      <iframe
        title={title}
        sandbox=""
        // A style after the end of the markup still applies: the parser moves it into the body.
        srcDoc={snapshot.html + pagesStyle}
        className="absolute left-0 top-0 origin-top-left border-0"
        style={size}
      />
    </div>
  )
}
