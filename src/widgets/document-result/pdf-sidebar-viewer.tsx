/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { PreviewNotice } from '@/components/preview-notice'
import { useHttpClient } from '@/contexts'
import { FileText, type LucideIcon, Presentation } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'
import { DocumentPreviewFrame } from './document-preview-frame'
import { type FileType, getFileType } from './file-type'
import type { DocumentSnapshot } from './snapshot'
import { SnapshotPages } from './snapshot-pages'
import { useDocumentBlob, useLocalDocumentBlob, type DocumentBlobState } from './use-document-blob'

// Configure the pdfjs worker via Vite's `new URL(..., import.meta.url)` pattern
// so the worker ships as its own bundle and is resolved relative to the build.
pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()

type Refusal = Exclude<DocumentSnapshot['kind'], 'pages'>

/** What the panel says in place of a snapshot it refused, for a document and for a deck. */
const refusals = {
  docx: {
    icon: FileText,
    tooLarge: {
      title: msg`This document is too large to preview`,
      body: msg`Download the file to open it in a word processor.`,
    },
    unreadable: {
      title: msg`This document can't be previewed`,
      body: msg`It may be damaged. Download the file to open it in a word processor.`,
    },
  },
  pptx: {
    icon: Presentation,
    tooLarge: {
      title: msg`This presentation is too large to preview`,
      body: msg`Download the file to open it in a presentation app.`,
    },
    unreadable: {
      title: msg`This presentation can't be previewed`,
      body: msg`It may be damaged. Download the file to open it in a presentation app.`,
    },
  },
} satisfies Record<
  'docx' | 'pptx',
  { icon: LucideIcon } & Record<Refusal, { title: MessageDescriptor; body: MessageDescriptor }>
>

type DocumentPreviewProps = {
  fileName: string
  fileType: FileType
  state: DocumentBlobState
  initialPage?: number
}

/**
 * Presentational document preview for the sideview slot: header + download,
 * react-pdf for PDFs, a DOCX's pages or a PPTX's slides in a sandboxed frame (or
 * a refusal past the preview's limits), and a download fallback otherwise. Source-agnostic: the
 * blob lifecycle is resolved by the caller (Haystack-backed or local IndexedDB)
 * and passed in as `state`.
 */
const DocumentPreview = ({ fileName, fileType, state, initialPage }: DocumentPreviewProps) => {
  const { i18n } = useLingui()
  const [numPages, setNumPages] = useState<number | null>(null)

  const onDocumentLoadSuccess = useCallback(({ numPages: pages }: { numPages: number }) => {
    setNumPages(pages)
  }, [])

  useEffect(() => {
    if (!initialPage || !numPages || initialPage > numPages) {
      return
    }
    const timer = setTimeout(() => {
      const el = document.querySelector(`[data-page-number="${initialPage}"]`)
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 100)
    return () => clearTimeout(timer)
  }, [initialPage, numPages])

  return (
    <DocumentPreviewFrame fileName={fileName} state={state}>
      {(ready) => {
        if (ready.snapshot?.kind === 'pages') {
          return <SnapshotPages title={fileName} snapshot={ready.snapshot} />
        }
        if (ready.snapshot) {
          const refusal = refusals[fileType === 'pptx' ? 'pptx' : 'docx']
          const { title, body } = refusal[ready.snapshot.kind]
          return (
            <PreviewNotice icon={refusal.icon} title={i18n._(title)}>
              {i18n._(body)}
            </PreviewNotice>
          )
        }
        return (
          <div className="flex-1 overflow-auto p-4">
            {fileType === 'pdf' ? (
              <Document file={ready.blobUrl} onLoadSuccess={onDocumentLoadSuccess} loading={null}>
                {numPages &&
                  Array.from({ length: numPages }, (_, i) => (
                    <div key={i + 1} data-page-number={i + 1}>
                      <Page pageNumber={i + 1} width={500} className="mb-4" />
                    </div>
                  ))}
              </Document>
            ) : (
              // A workbook from Haystack has no grid here: only a local one opens in the spreadsheet preview.
              <div className="flex h-full items-center justify-center">
                <p className="text-sm text-muted-foreground">
                  <Trans>Preview not available for this file type. Use the download button to view it.</Trans>
                </p>
              </div>
            )}
          </div>
        )
      }}
    </DocumentPreviewFrame>
  )
}

type PdfSidebarViewerProps = {
  fileId: string
  fileName: string
  initialPage?: number
}

/** Preview a Haystack-managed document (fetched from the backend by file id). */
export const PdfSidebarViewer = ({ fileId, fileName, initialPage }: PdfSidebarViewerProps) => {
  const httpClient = useHttpClient()
  const fileType = getFileType(fileName)
  const state = useDocumentBlob(fileId, fileType, httpClient)
  return <DocumentPreview fileName={fileName} fileType={fileType} state={state} initialPage={initialPage} />
}

type LocalPdfSidebarViewerProps = {
  localFileId: string
  fileName: string
  initialPage?: number
}

/** Preview a locally-uploaded attachment (read from IndexedDB, never the backend). */
export const LocalPdfSidebarViewer = ({ localFileId, fileName, initialPage }: LocalPdfSidebarViewerProps) => {
  const fileType = getFileType(fileName)
  const state = useLocalDocumentBlob(localFileId, fileType)
  return <DocumentPreview fileName={fileName} fileType={fileType} state={state} initialPage={initialPage} />
}
