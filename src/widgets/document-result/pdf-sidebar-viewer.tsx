import { ContentViewHeader } from '@/content-view/header'
import { useContentView } from '@/content-view/context'
import { useSettings } from '@/hooks/use-settings'
import { getAuthToken } from '@/lib/auth-token'
import { Button } from '@/components/ui/button'
import { Download, Loader2 } from 'lucide-react'
import ky, { type KyInstance } from 'ky'
import { useCallback, useEffect, useReducer, useRef } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()

type FetchDocumentFileOptions = {
  cloudUrl: string
  fileId: string
  getAuthToken: () => string | null
  httpClient?: KyInstance
}

/** Fetches a document file with auth and returns a blob URL. */
export const fetchDocumentFile = async ({
  cloudUrl,
  fileId,
  getAuthToken: getToken,
  httpClient = ky,
}: FetchDocumentFileOptions): Promise<string> => {
  const token = getToken()

  const blob = await httpClient
    .get(`${cloudUrl}/haystack/files/${fileId}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      credentials: 'include',
    })
    .blob()

  return URL.createObjectURL(blob)
}

type FileType = 'pdf' | 'unsupported'

const getFileType = (fileName: string): FileType => {
  const ext = fileName.split('.').pop()?.toLowerCase()
  if (ext === 'pdf') {
    return 'pdf'
  }
  return 'unsupported'
}

type ViewerState =
  | { status: 'loading' }
  | { status: 'loaded'; blobUrl: string | null; numPages: number | null }
  | { status: 'error'; message: string }

type ViewerAction =
  | { type: 'loaded'; blobUrl: string | null; numPages: number | null }
  | { type: 'set_pages'; numPages: number }
  | { type: 'error'; message: string }
  | { type: 'reset' }

const viewerReducer = (state: ViewerState, action: ViewerAction): ViewerState => {
  switch (action.type) {
    case 'loaded':
      return { status: 'loaded', blobUrl: action.blobUrl, numPages: action.numPages }
    case 'set_pages':
      if (state.status !== 'loaded') {
        return state
      }
      return { ...state, numPages: action.numPages }
    case 'error':
      return { status: 'error', message: action.message }
    case 'reset':
      return { status: 'loading' }
  }
}

type DocumentSidebarViewerProps = {
  fileId: string
  fileName: string
  initialPage?: number
}

export const PdfSidebarViewer = ({ fileId, fileName, initialPage }: DocumentSidebarViewerProps) => {
  const { close } = useContentView()
  const { cloudUrl } = useSettings({ cloud_url: 'http://localhost:8000/v1' })
  const [state, dispatch] = useReducer(viewerReducer, { status: 'loading' })
  const blobUrlRef = useRef<string | null>(null)

  const fileType = getFileType(fileName)

  useEffect(() => {
    let cancelled = false
    dispatch({ type: 'reset' })

    fetchDocumentFile({ cloudUrl: cloudUrl.value, fileId, getAuthToken })
      .then((url) => {
        if (cancelled) {
          URL.revokeObjectURL(url)
          return
        }
        blobUrlRef.current = url
        dispatch({ type: 'loaded', blobUrl: url, numPages: null })
      })
      .catch((err) => {
        if (!cancelled) {
          dispatch({ type: 'error', message: err instanceof Error ? err.message : 'Failed to load document' })
        }
      })

    return () => {
      cancelled = true
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current)
        blobUrlRef.current = null
      }
    }
  }, [fileId, fileType, cloudUrl.value])

  const blobUrl = state.status === 'loaded' ? state.blobUrl : null

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
    dispatch({ type: 'set_pages', numPages: pages })
  }, [])

  const numPages = state.status === 'loaded' ? state.numPages : null

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

      {state.status === 'loaded' && (
        <div className="flex-1 overflow-auto p-4">
          {fileType === 'pdf' && state.blobUrl && (
            <Document file={state.blobUrl} onLoadSuccess={onDocumentLoadSuccess} loading={null}>
              {state.numPages &&
                Array.from({ length: state.numPages }, (_, i) => (
                  <div key={i + 1} data-page-number={i + 1}>
                    <Page pageNumber={i + 1} width={500} className="mb-4" />
                  </div>
                ))}
            </Document>
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
