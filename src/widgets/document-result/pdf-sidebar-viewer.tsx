/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ContentViewHeader } from '@/content-view/header'
import { useContentView } from '@/content-view/context'
import { Button } from '@/components/ui/button'
import { useHttpClient } from '@/contexts'
import { Download, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'
import { useDocumentBlob, type FileType } from './use-document-blob'

// Configure the pdfjs worker via Vite's `new URL(..., import.meta.url)` pattern
// so the worker ships as its own bundle and is resolved relative to the build.
pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()

/** Returns the supported file type for previewing, based on extension. */
export const getFileType = (fileName: string): FileType => {
  const ext = fileName.split('.').pop()?.toLowerCase()
  if (ext === 'pdf') {
    return 'pdf'
  }
  if (ext === 'docx') {
    return 'docx'
  }
  return 'unsupported'
}

type PdfSidebarViewerProps = {
  fileId: string
  fileName: string
  initialPage?: number
}

/**
 * Renders an inline preview of a Haystack-managed document in the sideview slot.
 * Loads the file as a blob via the backend, renders PDFs with react-pdf, and
 * DOCX content via mammoth into a sandboxed iframe. Falls back to a download
 * prompt for other extensions.
 */
export const PdfSidebarViewer = ({ fileId, fileName, initialPage }: PdfSidebarViewerProps) => {
  const { close } = useContentView()
  const httpClient = useHttpClient()
  const fileType = getFileType(fileName)
  const state = useDocumentBlob(fileId, fileType, httpClient)
  const [numPages, setNumPages] = useState<number | null>(null)

  const blobUrl = state.status === 'ready' ? state.blobUrl : null

  const handleDownload = useCallback(() => {
    if (!blobUrl) {
      return
    }
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }, [blobUrl, fileName])

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

  const downloadAction = (
    <Button onClick={handleDownload} disabled={!blobUrl} variant="ghost" size="icon" className="h-8 w-8 rounded-full">
      <Download className="size-4" />
    </Button>
  )

  return (
    <div className="flex h-full flex-col">
      <ContentViewHeader title={fileName} onClose={close} actions={downloadAction} className="border-b border-border" />

      {state.status === 'loading' && (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {state.status === 'error' && (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-destructive">{state.message}</p>
        </div>
      )}

      {state.status === 'ready' && (
        <div className="flex-1 overflow-auto p-4">
          {fileType === 'pdf' && (
            <Document file={state.blobUrl} onLoadSuccess={onDocumentLoadSuccess} loading={null}>
              {numPages &&
                Array.from({ length: numPages }, (_, i) => (
                  <div key={i + 1} data-page-number={i + 1}>
                    <Page pageNumber={i + 1} width={500} className="mb-4" />
                  </div>
                ))}
            </Document>
          )}

          {fileType === 'docx' && state.docxHtml && (
            <iframe
              title={fileName}
              className="prose prose-sm dark:prose-invert max-w-none w-full h-full border-0"
              sandbox=""
              srcDoc={state.docxHtml}
            />
          )}

          {fileType === 'unsupported' && (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-muted-foreground">
                Preview not available for this file type. Use the download button to view it.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
