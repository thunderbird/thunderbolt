/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { pagesZoomToFit } from '@/widgets/document-result/snapshot'
import { useLocalDocumentBlob } from '@/widgets/document-result/use-document-blob'

type DocxThumbnailProps = {
  localFileId: string
  title: string
}

/**
 * A DOCX attachment's pages in a frame with `sandbox=""`, the same snapshot the side view shows, since the markup comes
 * from a file the user did not write. The frame fills the card, and the snapshot scales its pages down to the card's
 * width. In a browser that cannot do that, the frame has the pages' own width and is scaled into the card:
 * `--thumb-scale` fits 480px to the card's width. Renders nothing until the pages are ready, or when the document gets
 * no preview.
 */
export const DocxThumbnail = ({ localFileId, title }: DocxThumbnailProps) => {
  const state = useLocalDocumentBlob(localFileId, 'docx')
  if (state.status !== 'ready' || state.snapshot?.kind !== 'pages') {
    return null
  }
  const { html, width } = state.snapshot
  // 1.3 times as tall as wide covers the card at either size.
  const scaled = pagesZoomToFit()
    ? undefined
    : { width, height: width * 1.3, transform: `scale(calc(var(--thumb-scale, 0.3) * 480 / ${width}))` }
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden bg-white">
      <iframe
        title={title}
        // The card's button opens the file. WebKit would otherwise put focus inside the frame, where Enter and Space do nothing.
        tabIndex={-1}
        aria-hidden="true"
        sandbox=""
        srcDoc={html}
        scrolling="no"
        className="size-full origin-top-left border-0"
        style={scaled}
      />
    </div>
  )
}
