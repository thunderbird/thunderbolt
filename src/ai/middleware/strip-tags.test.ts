import type { LanguageModelV2StreamPart } from '@ai-sdk/provider'
import { describe, expect, it } from 'bun:test'
import { stripTagsMiddleware } from './strip-tags'

/** Helper: create a ReadableStream from an array of stream parts */
const createStreamFromParts = (parts: LanguageModelV2StreamPart[]): ReadableStream<LanguageModelV2StreamPart> =>
  new ReadableStream<LanguageModelV2StreamPart>({
    start(controller) {
      for (const p of parts) controller.enqueue(p)
      controller.close()
    },
  })

/** Helper: consume a stream into an array */
const collectParts = async (stream: ReadableStream<LanguageModelV2StreamPart>) => {
  const reader = stream.getReader()
  const out: LanguageModelV2StreamPart[] = []
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    out.push(value)
  }
  return out
}

describe('stripTagsMiddleware', () => {
  it('removes legacy <think> and <tool_call> tags but keeps normal content', async () => {
    const rawParts: LanguageModelV2StreamPart[] = [
      { type: 'text', text: '<think>Internal reasoning</think>' } as any,
      { type: 'text', text: '<tool_call>{"name":"getTasks"}</tool_call>' } as any,
      { type: 'text', text: 'Normal **bold** text' } as any,
    ]

    const { stream } = await (stripTagsMiddleware as any).wrapStream({
      // minimal doStream implementation expected by middleware
      doStream: (): Promise<any> => Promise.resolve({ stream: createStreamFromParts(rawParts) }),
    })

    const cleaned = await collectParts(stream)
    const combinedText = cleaned.map((p: any) => p.text).join('')

    expect(combinedText).toContain('Internal reasoning')
    expect(combinedText).toContain('Normal **bold** text')
    expect(/<\/?think/i.test(combinedText)).toBe(false)
    expect(/<\/?tool_call/i.test(combinedText)).toBe(false)
  })

  it('handles <tool_call> without closing tag', async () => {
    const rawParts: LanguageModelV2StreamPart[] = [
      { type: 'text', text: '<tool_call>{"name":"getTasks"}' } as any,
      { type: 'text', text: 'Bullet list item 1' } as any,
    ]

    const { stream } = await (stripTagsMiddleware as any).wrapStream({
      doStream: () => Promise.resolve({ stream: createStreamFromParts(rawParts) }),
    })

    const cleaned = await collectParts(stream)
    const combinedText = cleaned.map((p: any) => p.text).join('')

    expect(combinedText).toContain('Bullet list item 1')
    expect(/<\/?tool_call/i.test(combinedText)).toBe(false)
  })
})
