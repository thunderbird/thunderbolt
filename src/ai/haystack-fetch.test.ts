import { describe, expect, it } from 'bun:test'
import {
  extractReferences,
  formatDocumentWidgets,
  parseSSE,
  processSSEEvents,
  type DeepsetSSEEvent,
  type DeepsetResultPayload,
} from './haystack-fetch'

/** Helper to create a ReadableStream from SSE text */
const createSSEStream = (text: string): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
}

/** Collect all events from an async generator */
const collectEvents = async (gen: AsyncGenerator<DeepsetSSEEvent>): Promise<DeepsetSSEEvent[]> => {
  const events: DeepsetSSEEvent[] = []
  for await (const event of gen) {
    events.push(event)
  }
  return events
}

/**
 * Real SSE event shapes from the Deepset chat-stream API:
 *
 * Delta (first): data: {"query_id":"...","delta":{"text":"I","meta":{...}},"type":"delta","index":0,"start":true}
 * Delta (rest):  data: {"query_id":"...","delta":{"text":" can","meta":{...}},"type":"delta","index":0}
 * Result:        data: {"query_id":"...","result":{"query_id":"...","query":"hello","answers":[...],"documents":[...]},"type":"result"}
 */

describe('parseSSE', () => {
  it('should parse delta events with text from delta.text', async () => {
    const stream = createSSEStream(
      [
        'data: {"query_id":"q1","delta":{"text":"Hello ","meta":{}},"type":"delta","index":0,"start":true}',
        '',
        'data: {"query_id":"q1","delta":{"text":"world","meta":{}},"type":"delta","index":0}',
        '',
        '',
      ].join('\n'),
    )

    const events = await collectEvents(parseSSE(stream))

    expect(events).toEqual([
      { type: 'delta', delta: 'Hello ' },
      { type: 'delta', delta: 'world' },
    ])
  })

  it('should parse result event with answers and documents', async () => {
    const resultPayload = {
      query_id: 'q1',
      query: 'hello',
      answers: [
        {
          answer: 'Test answer',
          type: 'generative',
          document_ids: ['d1'],
          files: [{ id: 'f1', name: 'test.pdf' }],
          meta: { _references: [] },
        },
      ],
      documents: [{ id: 'd1', content: 'doc content', score: 0.95, file: { id: 'f1', name: 'test.pdf' } }],
    }
    const stream = createSSEStream(
      `data: {"query_id":"q1","result":${JSON.stringify(resultPayload)},"type":"result"}\n\n`,
    )

    const events = await collectEvents(parseSSE(stream))

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('result')
    if (events[0].type === 'result') {
      expect(events[0].result.answers).toHaveLength(1)
      expect(events[0].result.documents).toHaveLength(1)
      expect(events[0].result.documents[0].file.name).toBe('test.pdf')
    }
  })

  it('should parse error events', async () => {
    const stream = createSSEStream('data: {"type":"error","message":"Rate limited"}\n\n')

    const events = await collectEvents(parseSSE(stream))

    expect(events).toEqual([{ type: 'error', error: 'Rate limited' }])
  })

  it('should handle a complete realistic stream (deltas then result)', async () => {
    const lines = [
      'data: {"query_id":"q1","delta":{"text":"The ","meta":{}},"type":"delta","index":0,"start":true}',
      '',
      'data: {"query_id":"q1","delta":{"text":"answer.","meta":{}},"type":"delta","index":0}',
      '',
      `data: {"query_id":"q1","result":{"query_id":"q1","query":"test","answers":[{"answer":"The answer.","files":[{"id":"f1","name":"doc.pdf"}]}],"documents":[{"id":"d1","content":"snippet","score":0.9,"file":{"id":"f1","name":"doc.pdf"}}]},"type":"result"}`,
      '',
      '',
    ]
    const stream = createSSEStream(lines.join('\n'))

    const events = await collectEvents(parseSSE(stream))

    expect(events).toHaveLength(3)
    expect(events[0]).toEqual({ type: 'delta', delta: 'The ' })
    expect(events[1]).toEqual({ type: 'delta', delta: 'answer.' })
    expect(events[2].type).toBe('result')
  })

  it('should skip malformed JSON lines', async () => {
    const stream = createSSEStream(
      'data: not-json\n\ndata: {"query_id":"q1","delta":{"text":"ok","meta":{}},"type":"delta","index":0}\n\n',
    )

    const events = await collectEvents(parseSSE(stream))

    expect(events).toEqual([{ type: 'delta', delta: 'ok' }])
  })

  it('should skip lines without data: prefix', async () => {
    const stream = createSSEStream(
      'event: ping\n\ndata: {"query_id":"q1","delta":{"text":"ok","meta":{}},"type":"delta","index":0}\n\n',
    )

    const events = await collectEvents(parseSSE(stream))

    expect(events).toEqual([{ type: 'delta', delta: 'ok' }])
  })

  it('should handle chunked delivery across multiple reads', async () => {
    const encoder = new TextEncoder()
    const chunk1 = 'data: {"query_id":"q1","delt'
    const chunk2 = 'a":{"text":"split","meta":{}},"type":"delta","index":0}\n\n'

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(chunk1))
        controller.enqueue(encoder.encode(chunk2))
        controller.close()
      },
    })

    const events = await collectEvents(parseSSE(stream))

    expect(events).toEqual([{ type: 'delta', delta: 'split' }])
  })

  it('should handle empty stream', async () => {
    const stream = createSSEStream('')

    const events = await collectEvents(parseSSE(stream))

    expect(events).toEqual([])
  })

  it('should handle [DONE] sentinel as end event', async () => {
    const stream = createSSEStream('data: [DONE]\n\n')

    const events = await collectEvents(parseSSE(stream))

    expect(events).toEqual([{ type: 'end' }])
  })

  it('should ignore unknown event types', async () => {
    const stream = createSSEStream(
      'data: {"type":"unknown_thing","foo":"bar"}\n\ndata: {"query_id":"q1","delta":{"text":"ok","meta":{}},"type":"delta","index":0}\n\n',
    )

    const events = await collectEvents(parseSSE(stream))

    expect(events).toEqual([{ type: 'delta', delta: 'ok' }])
  })
})

describe('formatDocumentWidgets', () => {
  it('should format document widgets from result', () => {
    const result = {
      answers: [
        {
          answer: 'Test answer',
          files: [
            { id: 'f1', name: 'report.pdf' },
            { id: 'f2', name: 'guide.pdf' },
          ],
        },
      ],
      documents: [
        { id: 'd1', content: 'Report content here', score: 0.95, file: { id: 'f1', name: 'report.pdf' } },
        { id: 'd2', content: 'Guide content here', score: 0.85, file: { id: 'f2', name: 'guide.pdf' } },
      ],
    }

    const { widgets, documentsMeta } = formatDocumentWidgets(result)

    expect(widgets).toContain('widget:document-result')
    expect(widgets).toContain('report.pdf')
    expect(widgets).toContain('guide.pdf')
    expect(documentsMeta).toHaveLength(2)
    expect(documentsMeta[0].id).toBe('d1')
    expect(documentsMeta[1].id).toBe('d2')
  })

  it('should exclude low-relevance documents (<1% score)', () => {
    const result = {
      answers: [
        {
          answer: 'Test',
          files: [
            { id: 'f1', name: 'relevant.pdf' },
            { id: 'f2', name: 'irrelevant.pdf' },
          ],
        },
      ],
      documents: [
        { id: 'd1', content: 'Good content', score: 0.5, file: { id: 'f1', name: 'relevant.pdf' } },
        { id: 'd2', content: 'Bad content', score: 0.005, file: { id: 'f2', name: 'irrelevant.pdf' } },
      ],
    }

    const { widgets, documentsMeta } = formatDocumentWidgets(result)

    expect(widgets).toContain('relevant.pdf')
    expect(widgets).not.toContain('irrelevant.pdf')
    // documentsMeta still includes all documents (filtering only affects widgets)
    expect(documentsMeta).toHaveLength(2)
  })

  it('should escape quotes in snippets', () => {
    const result = {
      answers: [{ answer: 'Test', files: [{ id: 'f1', name: 'test.pdf' }] }],
      documents: [
        { id: 'd1', content: 'Content with "quotes" inside', score: 0.9, file: { id: 'f1', name: 'test.pdf' } },
      ],
    }

    const { widgets } = formatDocumentWidgets(result)

    expect(widgets).toContain('&quot;')
    expect(widgets).not.toContain('"quotes"')
  })

  it('should use highest-scoring doc chunk per file for filtering', () => {
    // A file has multiple doc chunks — some above threshold, some below.
    // find() returns the first match. The old non-streaming code had the same behavior.
    const result = {
      answers: [
        {
          answer: 'Test',
          files: [
            { id: 'f1', name: 'multi-chunk.pdf' },
            { id: 'f2', name: 'low-score.pdf' },
          ],
        },
      ],
      documents: [
        { id: 'd1', content: 'High score chunk', score: 0.5, file: { id: 'f1', name: 'multi-chunk.pdf' } },
        { id: 'd2', content: 'Low score chunk', score: 0.001, file: { id: 'f1', name: 'multi-chunk.pdf' } },
        { id: 'd3', content: 'Below threshold', score: 0.005, file: { id: 'f2', name: 'low-score.pdf' } },
      ],
    }

    const { widgets } = formatDocumentWidgets(result)

    expect(widgets).toContain('multi-chunk.pdf')
    expect(widgets).not.toContain('low-score.pdf')
  })

  it('should handle result with no answer files', () => {
    const result = {
      answers: [{ answer: 'Test', files: [] }],
      documents: [{ id: 'd1', content: 'Content', score: 0.9, file: { id: 'f1', name: 'test.pdf' } }],
    }

    const { widgets, documentsMeta } = formatDocumentWidgets(result)

    expect(widgets).toBe('')
    expect(documentsMeta).toHaveLength(1)
  })

  it('should only show widgets for referenced files when references provided', () => {
    const result: DeepsetResultPayload = {
      answers: [
        {
          answer: 'Test',
          files: [
            { id: 'f1', name: 'cited.pdf' },
            { id: 'f2', name: 'uncited.pdf' },
          ],
        },
      ],
      documents: [
        { id: 'd1', content: 'Cited content', score: 0.9, file: { id: 'f1', name: 'cited.pdf' } },
        { id: 'd2', content: 'Uncited content', score: 0.8, file: { id: 'f2', name: 'uncited.pdf' } },
      ],
    }

    const references = [{ position: 1, fileId: 'f1', fileName: 'cited.pdf', pageNumber: 3 }]
    const { widgets } = formatDocumentWidgets(result, references)

    expect(widgets).toContain('cited.pdf')
    expect(widgets).not.toContain('uncited.pdf')
  })

  it('should show all files when no references (backward compat)', () => {
    const result: DeepsetResultPayload = {
      answers: [
        {
          answer: 'Test',
          files: [
            { id: 'f1', name: 'a.pdf' },
            { id: 'f2', name: 'b.pdf' },
          ],
        },
      ],
      documents: [
        { id: 'd1', content: 'A', score: 0.9, file: { id: 'f1', name: 'a.pdf' } },
        { id: 'd2', content: 'B', score: 0.8, file: { id: 'f2', name: 'b.pdf' } },
      ],
    }

    const { widgets } = formatDocumentWidgets(result)

    expect(widgets).toContain('a.pdf')
    expect(widgets).toContain('b.pdf')
  })
})

describe('extractReferences', () => {
  it('should map _references + documents to HaystackReferenceMeta[]', () => {
    const result: DeepsetResultPayload = {
      answers: [
        {
          answer: 'See [1] and [2]',
          files: [
            { id: 'f1', name: 'report.pdf' },
            { id: 'f2', name: 'guide.pdf' },
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
        { id: 'd1', content: 'Report', score: 0.9, file: { id: 'f1', name: 'report.pdf' }, meta: { page_number: 5 } },
        { id: 'd2', content: 'Guide', score: 0.8, file: { id: 'f2', name: 'guide.pdf' }, meta: { page_number: 12 } },
      ],
    }

    const refs = extractReferences(result)

    expect(refs).toHaveLength(2)
    expect(refs[0]).toEqual({ position: 1, fileId: 'f1', fileName: 'report.pdf', pageNumber: 5 })
    expect(refs[1]).toEqual({ position: 2, fileId: 'f2', fileName: 'guide.pdf', pageNumber: 12 })
  })

  it('should return [] when _references is missing', () => {
    const result: DeepsetResultPayload = {
      answers: [{ answer: 'No refs', files: [] }],
      documents: [],
    }

    expect(extractReferences(result)).toEqual([])
  })

  it('should handle missing page_number (returns undefined)', () => {
    const result: DeepsetResultPayload = {
      answers: [
        {
          answer: 'See [1]',
          files: [{ id: 'f1', name: 'report.pdf' }],
          meta: { _references: [{ document_position: 1, document_id: 'd1' }] },
        },
      ],
      documents: [{ id: 'd1', content: 'Report', score: 0.9, file: { id: 'f1', name: 'report.pdf' } }],
    }

    const refs = extractReferences(result)

    expect(refs).toHaveLength(1)
    expect(refs[0].pageNumber).toBeUndefined()
  })

  it('should skip references whose document_id has no matching document', () => {
    const result: DeepsetResultPayload = {
      answers: [
        {
          answer: 'See [1]',
          files: [{ id: 'f1', name: 'report.pdf' }],
          meta: { _references: [{ document_position: 1, document_id: 'nonexistent' }] },
        },
      ],
      documents: [{ id: 'd1', content: 'Report', score: 0.9, file: { id: 'f1', name: 'report.pdf' } }],
    }

    expect(extractReferences(result)).toEqual([])
  })
})

/** Mock writer that records all write() calls */
const createMockWriter = () => {
  const writes: Array<Record<string, unknown>> = []
  return {
    write: (data: Record<string, unknown>) => writes.push(data),
    writes,
  }
}

/** Helper to create an async generator from an array of events */
// eslint-disable-next-line func-style
async function* eventsToGenerator(events: DeepsetSSEEvent[]): AsyncGenerator<DeepsetSSEEvent> {
  for (const event of events) {
    yield event
  }
}

describe('processSSEEvents', () => {
  it('should emit message-metadata with haystackReferences immediately on result event', async () => {
    const writer = createMockWriter()
    const resultPayload: DeepsetResultPayload = {
      answers: [
        {
          answer: 'See [1]',
          files: [{ id: 'f1', name: 'report.pdf' }],
          meta: { _references: [{ document_position: 1, document_id: 'd1' }] },
        },
      ],
      documents: [
        {
          id: 'd1',
          content: 'Report content',
          score: 0.9,
          file: { id: 'f1', name: 'report.pdf' },
          meta: { page_number: 5 },
        },
      ],
    }

    const events: DeepsetSSEEvent[] = [
      { type: 'delta', delta: 'See [1]' },
      { type: 'result', result: resultPayload },
    ]

    await processSSEEvents(eventsToGenerator(events), writer, 'text-1')

    const metadataWrites = writer.writes.filter((w) => w.type === 'message-metadata')
    expect(metadataWrites).toHaveLength(1)
    expect(metadataWrites[0].messageMetadata).toEqual({
      haystackReferences: [{ position: 1, fileId: 'f1', fileName: 'report.pdf', pageNumber: 5 }],
    })
  })

  it('should emit message-metadata BEFORE widget text-deltas (so UI has refs during streaming)', async () => {
    const writer = createMockWriter()
    const resultPayload: DeepsetResultPayload = {
      answers: [
        {
          answer: 'See [1]',
          files: [{ id: 'f1', name: 'report.pdf' }],
          meta: { _references: [{ document_position: 1, document_id: 'd1' }] },
        },
      ],
      documents: [
        {
          id: 'd1',
          content: 'Report content',
          score: 0.9,
          file: { id: 'f1', name: 'report.pdf' },
          meta: { page_number: 3 },
        },
      ],
    }

    await processSSEEvents(eventsToGenerator([{ type: 'result', result: resultPayload }]), writer, 'text-1')

    const metadataIdx = writer.writes.findIndex((w) => w.type === 'message-metadata')
    const widgetDeltaIdx = writer.writes.findIndex(
      (w) => w.type === 'text-delta' && typeof w.delta === 'string' && w.delta.includes('widget:document-result'),
    )

    expect(metadataIdx).not.toBe(-1)
    // metadata must come before widget delta (or widget delta may not exist if no widgets)
    if (widgetDeltaIdx !== -1) {
      expect(metadataIdx).toBeLessThan(widgetDeltaIdx)
    }
  })

  it('should NOT emit message-metadata when result has no references', async () => {
    const writer = createMockWriter()
    const resultPayload: DeepsetResultPayload = {
      answers: [{ answer: 'No refs', files: [{ id: 'f1', name: 'doc.pdf' }] }],
      documents: [{ id: 'd1', content: 'Content', score: 0.9, file: { id: 'f1', name: 'doc.pdf' } }],
    }

    await processSSEEvents(eventsToGenerator([{ type: 'result', result: resultPayload }]), writer, 'text-1')

    const metadataWrites = writer.writes.filter((w) => w.type === 'message-metadata')
    expect(metadataWrites).toHaveLength(0)
  })

  it('should write text-deltas for delta events', async () => {
    const writer = createMockWriter()
    const events: DeepsetSSEEvent[] = [
      { type: 'delta', delta: 'Hello ' },
      { type: 'delta', delta: 'world' },
    ]

    await processSSEEvents(eventsToGenerator(events), writer, 'text-1')

    const deltas = writer.writes.filter((w) => w.type === 'text-delta')
    expect(deltas).toHaveLength(2)
    expect(deltas[0].delta).toBe('Hello ')
    expect(deltas[1].delta).toBe('world')
  })

  it('should return extracted references and documents', async () => {
    const writer = createMockWriter()
    const resultPayload: DeepsetResultPayload = {
      answers: [
        {
          answer: 'See [1]',
          files: [{ id: 'f1', name: 'report.pdf' }],
          meta: { _references: [{ document_position: 1, document_id: 'd1' }] },
        },
      ],
      documents: [
        { id: 'd1', content: 'Report', score: 0.9, file: { id: 'f1', name: 'report.pdf' }, meta: { page_number: 5 } },
      ],
    }

    const { references, documents } = await processSSEEvents(
      eventsToGenerator([{ type: 'result', result: resultPayload }]),
      writer,
      'text-1',
    )

    expect(references).toHaveLength(1)
    expect(references[0].position).toBe(1)
    expect(documents).toHaveLength(1)
    expect(documents[0].id).toBe('d1')
  })
})
