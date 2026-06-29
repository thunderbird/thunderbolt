/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLocalDocumentBlob } from '@/widgets/document-result/use-document-blob'
import { Document, Page, pdfjs } from 'react-pdf'

// Same pdfjs worker config as the sideview viewer (idempotent if both run).
pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()

type PdfThumbnailProps = {
  localFileId: string
  /** Render width in CSS px; the page keeps its aspect ratio. */
  width: number
}

/**
 * First-page PDF thumbnail rendered from a locally-stored attachment. Default
 * export so {@link FileCard} can `React.lazy` it — that keeps react-pdf / pdfjs
 * out of the main chat bundle until an attachment card actually mounts.
 *
 * Returns null until the blob resolves; the card shows its own placeholder
 * underneath, so the page simply fades in on top once rendered.
 */
const PdfThumbnail = ({ localFileId, width }: PdfThumbnailProps) => {
  const state = useLocalDocumentBlob(localFileId, 'pdf')
  if (state.status !== 'ready') {
    return null
  }
  return (
    <Document file={state.blobUrl} loading={null} error={null}>
      <Page pageNumber={1} width={width} renderTextLayer={false} renderAnnotationLayer={false} loading={null} />
    </Document>
  )
}

export default PdfThumbnail
