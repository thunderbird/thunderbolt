/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useViewSize } from '@/hooks/use-view-size'
import { useRef } from 'react'
import type { DocxSnapshot } from './docx-snapshot'

type DocxPagesProps = {
  title: string
  snapshot: Extract<DocxSnapshot, { kind: 'pages' }>
}

/**
 * A document's pages in a frame with `sandbox=""`. Pages wider than the panel, as on a phone, scale down to its width:
 * the frame keeps the pages' own width and is drawn smaller, and it scrolls the pages itself.
 */
export const DocxPages = ({ title, snapshot }: DocxPagesProps) => {
  const ref = useRef<HTMLDivElement>(null)
  const view = useViewSize(ref)
  const scale = view.width > 0 && view.width < snapshot.width ? view.width / snapshot.width : 1
  const size =
    scale < 1
      ? { width: snapshot.width, height: view.height / scale, transform: `scale(${scale})` }
      : { width: '100%', height: '100%' }
  return (
    <div ref={ref} className="relative min-h-0 flex-1 overflow-hidden">
      <iframe
        title={title}
        sandbox=""
        srcDoc={snapshot.html}
        className="absolute left-0 top-0 origin-top-left border-0"
        style={size}
      />
    </div>
  )
}
