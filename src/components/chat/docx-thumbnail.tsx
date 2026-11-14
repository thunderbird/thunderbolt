/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLocalDocumentBlob } from '@/widgets/document-result/use-document-blob'

type DocxThumbnailProps = {
  localFileId: string
  title: string
}

/**
 * A DOCX attachment's pages in a frame with `sandbox=""`, the same snapshot the side view shows, since the markup comes
 * from a file the user did not write. The frame has the pages' own width and is scaled into the card: `--thumb-scale`
 * fits 480px to the card's width. Renders nothing until the pages are ready, or when the document gets no preview.
 */
export const DocxThumbnail = ({ localFileId, title }: DocxThumbnailProps) => {
  const state = useLocalDocumentBlob(localFileId, 'docx')
  if (state.status !== 'ready' || state.docx?.kind !== 'pages') {
    return null
  }
  const { html, width } = state.docx
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden bg-white">
      <iframe
        title={title}
        sandbox=""
        srcDoc={html}
        scrolling="no"
        className="origin-top-left border-0"
        // 1.3 times as tall as wide covers the card at either size.
        style={{ width, height: width * 1.3, transform: `scale(calc(var(--thumb-scale, 0.3) * 480 / ${width}))` }}
      />
    </div>
  )
}
