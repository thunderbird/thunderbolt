import { describe, expect, it } from 'bun:test'
import { parseSSE, formatDocumentWidgets, type DeepsetSSEEvent } from './haystack-fetch'

const BACKEND_URL = 'http://localhost:8000/v1'

/** Collect all events from an async generator */
const collectEvents = async (gen: AsyncGenerator<DeepsetSSEEvent>): Promise<DeepsetSSEEvent[]> => {
  const events: DeepsetSSEEvent[] = []
  for await (const event of gen) {
    events.push(event)
  }
  return events
}

describe('haystack-fetch e2e', () => {
  it('should create a session, stream a query, and parse deltas + result', async () => {
    // 1. Create a session
    const sessionRes = await fetch(`${BACKEND_URL}/haystack/sessions`, { method: 'POST' })
    expect(sessionRes.ok).toBe(true)
    const sessionData = (await sessionRes.json()) as { data: { searchSessionId: string }; success: boolean }
    expect(sessionData.success).toBe(true)
    const sessionId = sessionData.data.searchSessionId
    expect(typeof sessionId).toBe('string')

    // 2. Call chat-stream
    const streamRes = await fetch(`${BACKEND_URL}/haystack/chat-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'What is GDPR?', sessionId }),
    })
    expect(streamRes.ok).toBe(true)
    expect(streamRes.body).toBeTruthy()

    // 3. Parse SSE events
    const events = await collectEvents(parseSSE(streamRes.body!))

    // Should have at least some delta events and exactly one result
    const deltas = events.filter((e) => e.type === 'delta')
    const results = events.filter((e) => e.type === 'result')
    const errors = events.filter((e) => e.type === 'error')

    expect(errors).toHaveLength(0)
    expect(deltas.length).toBeGreaterThan(0)
    expect(results).toHaveLength(1)

    // Verify delta shape
    for (const d of deltas) {
      if (d.type === 'delta') {
        expect(typeof d.delta).toBe('string')
      }
    }

    // Verify result shape matches what formatDocumentWidgets expects
    const result = results[0]
    if (result.type === 'result') {
      expect(Array.isArray(result.result.answers)).toBe(true)
      expect(Array.isArray(result.result.documents)).toBe(true)
      expect(result.result.answers.length).toBeGreaterThan(0)
      expect(result.result.documents.length).toBeGreaterThan(0)

      // Verify answer has files
      const answer = result.result.answers[0]
      expect(typeof answer.answer).toBe('string')
      expect(Array.isArray(answer.files)).toBe(true)

      // Verify document shape
      const doc = result.result.documents[0]
      expect(typeof doc.id).toBe('string')
      expect(typeof doc.content).toBe('string')
      expect(typeof doc.score).toBe('number')
      expect(typeof doc.file.id).toBe('string')
      expect(typeof doc.file.name).toBe('string')

      // 4. Verify formatDocumentWidgets works with real data
      const { documentsMeta } = formatDocumentWidgets(result.result)
      expect(documentsMeta.length).toBeGreaterThan(0)

      // Streamed deltas may include citation markers (e.g. [1]) not in the clean answer,
      // so just verify the stream produced non-trivial text
      const streamedText = deltas.map((d) => (d.type === 'delta' ? d.delta : '')).join('')
      expect(streamedText.length).toBeGreaterThan(10)
    }
  }, 30_000)
})
