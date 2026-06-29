/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLocalDocumentBlob } from '@/widgets/document-result/use-document-blob'
import { Document, Page, pdfjs } from 'react-pdf'

// Same pdfjs worker config as the sideview viewer (idempotent if both run).
pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()

/** Base render width (px); the card scales it down via `--thumb-scale`. Rendering
 *  larger than displayed keeps the thumbnail crisp. */
const baseWidthPx = 480

type PdfThumbnailProps = {
  localFileId: string
}

/**
 * First-page PDF thumbnail rendered from a locally-stored attachment, sized via
 * the card's responsive `--thumb-scale` CSS variable. Default export so
 * {@link FileCard} can `React.lazy` it — that keeps react-pdf / pdfjs out of the
 * main chat bundle until an attachment card actually mounts. Returns null until
 * the blob resolves; the card's placeholder shows underneath until then.
 */
const PdfThumbnail = ({ localFileId }: PdfThumbnailProps) => {
  const state = useLocalDocumentBlob(localFileId, 'pdf')
  if (state.status !== 'ready') {
    return null
  }
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden bg-white">
      <div className="origin-top-left" style={{ transform: 'scale(var(--thumb-scale, 0.3))' }}>
        <Document file={state.blobUrl} loading={null} error={null}>
          <Page
            pageNumber={1}
            width={baseWidthPx}
            renderTextLayer={false}
            renderAnnotationLayer={false}
            loading={null}
          />
        </Document>
      </div>
    </div>
  )
}

export default PdfThumbnail
