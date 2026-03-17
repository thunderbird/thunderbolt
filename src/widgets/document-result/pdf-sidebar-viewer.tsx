import { getSettings } from '@/dal'
import { getDb } from '@/db/database'
import { ContentViewHeader } from '@/content-view/header'
import { useContentView } from '@/content-view/context'
import { Button } from '@/components/ui/button'
import { Download, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()

type FileType = 'pdf' | 'docx' | 'unsupported'

const getFileType = (fileName: string): FileType => {
  const ext = fileName.split('.').pop()?.toLowerCase()
  if (ext === 'pdf') {
    return 'pdf'
  }
  if (ext === 'docx') {
    return 'docx'
  }
  return 'unsupported'
}

type DocumentSidebarViewerProps = {
  fileId: string
  fileName: string
  initialPage?: number
}

export const PdfSidebarViewer = ({ fileId, fileName, initialPage }: DocumentSidebarViewerProps) => {
  const { close } = useContentView()
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [docxHtml, setDocxHtml] = useState<string | null>(null)
  const [numPages, setNumPages] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fileType = getFileType(fileName)

  useEffect(() => {
    let cancelled = false

    const fetchFile = async () => {
      const db = getDb()
      const { cloudUrl } = await getSettings(db, { cloud_url: 'http://localhost:8000/v1' })

      const response = await fetch(`${cloudUrl}/haystack/files/${fileId}`)

      if (!response.ok) {
        throw new Error(`Failed to download file: ${response.status}`)
      }

      const blob = await response.blob()

      if (cancelled) {
        return
      }

      if (fileType === 'docx') {
        const mammoth = await import('mammoth')
        const arrayBuffer = await blob.arrayBuffer()
        const result = await mammoth.convertToHtml({ arrayBuffer })
        if (!cancelled) {
          setDocxHtml(result.value)
          // Still create blob URL for download
          setBlobUrl(URL.createObjectURL(blob))
          setLoading(false)
        }
      } else {
        const url = URL.createObjectURL(blob)
        if (!cancelled) {
          setBlobUrl(url)
          setLoading(false)
        } else {
          URL.revokeObjectURL(url)
        }
      }
    }

    fetchFile().catch((err) => {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : 'Failed to load document')
        setLoading(false)
      }
    })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, fileType])

  // Clean up blob URL on unmount
  useEffect(() => {
    return () => {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  // Scroll to initial page after all pages render
  useEffect(() => {
    if (!initialPage || !numPages || initialPage > numPages) {
      return
    }
    // Allow a frame for pages to render
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
      {loading && (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {error && (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {!loading && !error && (
        <div className="flex-1 overflow-auto p-4">
          {fileType === 'pdf' && blobUrl && (
            <Document file={blobUrl} onLoadSuccess={onDocumentLoadSuccess} loading={null}>
              {numPages &&
                Array.from({ length: numPages }, (_, i) => (
                  <div key={i + 1} data-page-number={i + 1}>
                    <Page pageNumber={i + 1} width={500} className="mb-4" />
                  </div>
                ))}
            </Document>
          )}

          {fileType === 'docx' && docxHtml && (
            <iframe
              className="prose prose-sm dark:prose-invert max-w-none w-full h-full border-0"
              sandbox=""
              srcDoc={docxHtml}
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
