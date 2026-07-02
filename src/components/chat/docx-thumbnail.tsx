/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLocalDocumentBlob } from '@/widgets/document-result/use-document-blob'

type DocxThumbnailProps = {
  localFileId: string
  title: string
}

/**
 * Renders a docx attachment with its formatting, via mammoth-converted HTML in a
 * fully **sandboxed** iframe (same security posture as the document sideview —
 * the HTML comes from an untrusted user file). Rendered at 480px wide then
 * transform-scaled into the 160px card. Returns null until the blob resolves.
 */
export const DocxThumbnail = ({ localFileId, title }: DocxThumbnailProps) => {
  const state = useLocalDocumentBlob(localFileId, 'docx')
  if (state.status !== 'ready' || !state.docxHtml) {
    return null
  }
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden bg-white">
      <iframe
        title={title}
        sandbox=""
        srcDoc={state.docxHtml}
        scrolling="no"
        className="h-[528px] w-[480px] origin-top-left border-0"
        style={{ transform: 'scale(var(--thumb-scale, 0.3))' }}
      />
    </div>
  )
}
