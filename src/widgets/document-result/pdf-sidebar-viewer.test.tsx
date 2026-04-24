import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { createClient } from '@/lib/http'
import { fetchDocumentFile } from './pdf-sidebar-viewer'

describe('PdfSidebarViewer file type detection', () => {
  const getFileType = (fileName: string): 'pdf' | 'unsupported' => {
    const ext = fileName.split('.').pop()?.toLowerCase()
    if (ext === 'pdf') {
      return 'pdf'
    }
    return 'unsupported'
  }

  it('recognizes .pdf files', () => {
    expect(getFileType('report.pdf')).toBe('pdf')
    expect(getFileType('Report.PDF')).toBe('pdf')
    expect(getFileType('my.file.pdf')).toBe('pdf')
  })

  it('treats .docx as unsupported', () => {
    expect(getFileType('notes.docx')).toBe('unsupported')
  })

  it('treats .doc as unsupported', () => {
    expect(getFileType('notes.doc')).toBe('unsupported')
  })

  it('treats other extensions as unsupported', () => {
    expect(getFileType('image.png')).toBe('unsupported')
    expect(getFileType('data.csv')).toBe('unsupported')
    expect(getFileType('readme.txt')).toBe('unsupported')
  })
})

describe('fetchDocumentFile', () => {
  const cloudUrl = 'https://example.com/v1'
  const fileId = 'abc-123'

  type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

  const makeClient = (mockFetch: FetchFn) => createClient({ fetch: mockFetch as typeof fetch })

  const successFetch =
    (onRequest?: (req: Request) => void): FetchFn =>
    async (input) => {
      const req = input instanceof Request ? input : new Request(input)
      onRequest?.(req)
      return new Response(new Blob(['fake-pdf'], { type: 'application/pdf' }), { status: 200 })
    }

  let revokeObjectURL: ReturnType<typeof spyOn>
  let createObjectURL: ReturnType<typeof spyOn>

  beforeEach(() => {
    createObjectURL = spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake-url')
    revokeObjectURL = spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  })

  afterEach(() => {
    createObjectURL.mockRestore()
    revokeObjectURL.mockRestore()
  })

  it('sends Authorization header with Bearer token when token exists', async () => {
    let capturedReq: Request | undefined
    const httpClient = makeClient(successFetch((req) => (capturedReq = req)))

    await fetchDocumentFile({
      cloudUrl,
      fileId,
      getAuthToken: () => 'my-token',
      httpClient,
    })

    expect(capturedReq?.headers.get('Authorization')).toBe('Bearer my-token')
  })

  it('sends no Authorization header when token is null', async () => {
    let capturedReq: Request | undefined
    const httpClient = makeClient(successFetch((req) => (capturedReq = req)))

    await fetchDocumentFile({
      cloudUrl,
      fileId,
      getAuthToken: () => null,
      httpClient,
    })

    expect(capturedReq?.headers.get('Authorization')).toBeNull()
  })

  it('fetches from the correct URL', async () => {
    let capturedReq: Request | undefined
    const httpClient = makeClient(successFetch((req) => (capturedReq = req)))

    await fetchDocumentFile({
      cloudUrl,
      fileId,
      getAuthToken: () => null,
      httpClient,
    })

    expect(capturedReq?.url).toBe('https://example.com/v1/haystack/files/abc-123')
  })

  it('returns a blob URL on success', async () => {
    const httpClient = makeClient(successFetch())

    const result = await fetchDocumentFile({
      cloudUrl,
      fileId,
      getAuthToken: () => 'tok',
      httpClient,
    })

    expect(result).toBe('blob:fake-url')
  })

  it('throws on non-ok response', async () => {
    const mockFetch: FetchFn = async () => new Response('Unauthorized', { status: 401 })
    const httpClient = makeClient(mockFetch)

    expect(
      fetchDocumentFile({
        cloudUrl,
        fileId,
        getAuthToken: () => 'tok',
        httpClient,
      }),
    ).rejects.toThrow()
  })

  it('includes credentials in the request', async () => {
    let capturedReq: Request | undefined
    const httpClient = makeClient(successFetch((req) => (capturedReq = req)))

    await fetchDocumentFile({
      cloudUrl,
      fileId,
      getAuthToken: () => 'tok',
      httpClient,
    })

    expect(capturedReq?.credentials).toBe('include')
  })
})
