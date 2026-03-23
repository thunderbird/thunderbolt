import { describe, expect, it } from 'bun:test'
import { parseSSE, extractReferences, extractDocuments } from './sse-parser'
import type { DeepsetResultPayload } from './types'

const encode = (text: string) => new TextEncoder().encode(text)

const createSSEStream = (chunks: string[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encode(chunk))
      }
      controller.close()
    },
  })

const collectEvents = async (stream: ReadableStream<Uint8Array>) => {
  const events = []
  for await (const event of parseSSE(stream)) {
    events.push(event)
  }
  return events
}

describe('parseSSE', () => {
  it('should parse delta events', async () => {
    const stream = createSSEStream(['data: {"type":"delta","delta":{"text":"Hello"}}\n\n'])
    const events = await collectEvents(stream)

    expect(events).toEqual([{ type: 'delta', delta: 'Hello' }])
  })

  it('should parse multiple deltas across chunks', async () => {
    const stream = createSSEStream([
      'data: {"type":"delta","delta":{"text":"Hel"}}\n\n',
      'data: {"type":"delta","delta":{"text":"lo"}}\n\n',
    ])
    const events = await collectEvents(stream)

    expect(events).toEqual([
      { type: 'delta', delta: 'Hel' },
      { type: 'delta', delta: 'lo' },
    ])
  })

  it('should handle events split across chunks', async () => {
    const stream = createSSEStream(['data: {"type":"delta","del', 'ta":{"text":"split"}}\n\n'])
    const events = await collectEvents(stream)

    expect(events).toEqual([{ type: 'delta', delta: 'split' }])
  })

  it('should parse result events', async () => {
    const result: DeepsetResultPayload = {
      answers: [{ answer: 'test', files: [], meta: { _references: [] } }],
      documents: [],
    }
    const stream = createSSEStream([`data: {"type":"result","result":${JSON.stringify(result)}}\n\n`])
    const events = await collectEvents(stream)

    expect(events).toEqual([{ type: 'result', result }])
  })

  it('should parse error events', async () => {
    const stream = createSSEStream(['data: {"type":"error","message":"Something went wrong"}\n\n'])
    const events = await collectEvents(stream)

    expect(events).toEqual([{ type: 'error', error: 'Something went wrong' }])
  })

  it('should parse [DONE] as end event', async () => {
    const stream = createSSEStream(['data: [DONE]\n\n'])
    const events = await collectEvents(stream)

    expect(events).toEqual([{ type: 'end' }])
  })

  it('should skip non-data lines', async () => {
    const stream = createSSEStream([': comment\n\n', 'data: {"type":"delta","delta":{"text":"ok"}}\n\n'])
    const events = await collectEvents(stream)

    expect(events).toEqual([{ type: 'delta', delta: 'ok' }])
  })

  it('should skip malformed JSON', async () => {
    const stream = createSSEStream([
      'data: {not valid json}\n\n',
      'data: {"type":"delta","delta":{"text":"after"}}\n\n',
    ])
    const events = await collectEvents(stream)

    expect(events).toEqual([{ type: 'delta', delta: 'after' }])
  })

  it('should handle empty stream', async () => {
    const stream = createSSEStream([])
    const events = await collectEvents(stream)

    expect(events).toEqual([])
  })

  it('should handle a complete chat-stream sequence', async () => {
    const stream = createSSEStream([
      'data: {"type":"delta","delta":{"text":"The document"}}\n\n',
      'data: {"type":"delta","delta":{"text":" discusses [1]"}}\n\n',
      `data: {"type":"result","result":{"answers":[{"answer":"The document discusses [1]","files":[{"id":"f1","name":"doc.pdf"}],"meta":{"_references":[{"document_position":1,"document_id":"d1"}]}}],"documents":[{"id":"d1","content":"content","score":0.9,"file":{"id":"f1","name":"doc.pdf"}}]}}\n\n`,
      'data: [DONE]\n\n',
    ])
    const events = await collectEvents(stream)

    expect(events).toHaveLength(4)
    expect(events[0].type).toBe('delta')
    expect(events[1].type).toBe('delta')
    expect(events[2].type).toBe('result')
    expect(events[3].type).toBe('end')
  })
})

describe('extractReferences', () => {
  it('should extract references with file info from documents', () => {
    const result: DeepsetResultPayload = {
      answers: [
        {
          answer: 'Answer text [1]',
          files: [{ id: 'f1', name: 'doc.pdf' }],
          meta: {
            _references: [{ document_position: 1, document_id: 'd1' }],
          },
        },
      ],
      documents: [
        {
          id: 'd1',
          content: 'document content',
          score: 0.9,
          file: { id: 'f1', name: 'doc.pdf' },
          meta: { page_number: 5 },
        },
      ],
    }

    const refs = extractReferences(result)

    expect(refs).toEqual([{ position: 1, fileId: 'f1', fileName: 'doc.pdf', pageNumber: 5 }])
  })

  it('should return empty array when no references', () => {
    const result: DeepsetResultPayload = {
      answers: [{ answer: 'No refs', files: [], meta: { _references: [] } }],
      documents: [],
    }

    expect(extractReferences(result)).toEqual([])
  })

  it('should return empty array when no answers', () => {
    const result: DeepsetResultPayload = {
      answers: [],
      documents: [],
    }

    expect(extractReferences(result)).toEqual([])
  })

  it('should skip references with no matching document', () => {
    const result: DeepsetResultPayload = {
      answers: [
        {
          answer: 'text',
          files: [],
          meta: { _references: [{ document_position: 1, document_id: 'nonexistent' }] },
        },
      ],
      documents: [],
    }

    expect(extractReferences(result)).toEqual([])
  })

  it('should handle references without page numbers', () => {
    const result: DeepsetResultPayload = {
      answers: [
        {
          answer: 'text',
          files: [{ id: 'f1', name: 'doc.pdf' }],
          meta: { _references: [{ document_position: 1, document_id: 'd1' }] },
        },
      ],
      documents: [{ id: 'd1', content: 'text', score: 0.5, file: { id: 'f1', name: 'doc.pdf' } }],
    }

    const refs = extractReferences(result)
    expect(refs[0].pageNumber).toBeUndefined()
  })

  it('should handle multiple references', () => {
    const result: DeepsetResultPayload = {
      answers: [
        {
          answer: 'text [1] [2]',
          files: [
            { id: 'f1', name: 'a.pdf' },
            { id: 'f2', name: 'b.pdf' },
          ],
          meta: {
            _references: [
              { document_position: 1, document_id: 'd1' },
              { document_position: 2, document_id: 'd2' },
            ],
          },
        },
      ],
      documents: [
        { id: 'd1', content: 'a', score: 0.9, file: { id: 'f1', name: 'a.pdf' }, meta: { page_number: 1 } },
        { id: 'd2', content: 'b', score: 0.8, file: { id: 'f2', name: 'b.pdf' }, meta: { page_number: 3 } },
      ],
    }

    const refs = extractReferences(result)
    expect(refs).toHaveLength(2)
    expect(refs[0]).toEqual({ position: 1, fileId: 'f1', fileName: 'a.pdf', pageNumber: 1 })
    expect(refs[1]).toEqual({ position: 2, fileId: 'f2', fileName: 'b.pdf', pageNumber: 3 })
  })
})

describe('extractDocuments', () => {
  it('should extract document metadata', () => {
    const result: DeepsetResultPayload = {
      answers: [],
      documents: [
        { id: 'd1', content: 'Content text', score: 0.95, file: { id: 'f1', name: 'report.pdf' } },
        { id: 'd2', content: 'Other text', score: 0.3, file: { id: 'f2', name: 'notes.docx' } },
      ],
    }

    const docs = extractDocuments(result)

    expect(docs).toEqual([
      { id: 'd1', content: 'Content text', score: 0.95, file: { id: 'f1', name: 'report.pdf' } },
      { id: 'd2', content: 'Other text', score: 0.3, file: { id: 'f2', name: 'notes.docx' } },
    ])
  })

  it('should return empty array for no documents', () => {
    expect(extractDocuments({ answers: [], documents: [] })).toEqual([])
  })
})
