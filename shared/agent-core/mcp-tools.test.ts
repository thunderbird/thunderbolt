/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for {@link toPiAgentTools} — the AI-SDK→Pi tool bridge.
 *
 * Focus: the two boundaries the module bridges (namespaced-name preservation +
 * schema mapping at FFI, and result mapping through `toModelOutput`), plus the
 * never-mask error contract (an MCP `{ isError: true }` result must surface as a
 * THROW, not a successful tool result) and the streaming-`execute` normalisation.
 */

import { describe, expect, it } from 'bun:test'
import { jsonSchema, type Tool } from 'ai'
import { z } from 'zod'
import { toPiAgentTools } from './mcp-tools.ts'

type ToolExecute = NonNullable<Tool['execute']>
type ToModelOutput = NonNullable<Tool['toModelOutput']>

/** Build a minimal AI-SDK `Tool` exposing exactly the fields the bridge reads. */
const makeTool = (def: {
  description?: string
  title?: string
  inputSchema?: Tool['inputSchema']
  execute?: ToolExecute
  toModelOutput?: ToModelOutput
}): Tool =>
  ({
    inputSchema: def.inputSchema ?? jsonSchema({ type: 'object', properties: {} }),
    description: def.description,
    title: def.title,
    execute: def.execute,
    toModelOutput: def.toModelOutput,
  }) as unknown as Tool

/** Drive a single converted tool's `execute` with the Pi calling convention. */
const runPiTool = (
  tool: { execute: (id: string, params: unknown, signal?: AbortSignal) => unknown },
  params: unknown,
) => tool.execute('call-1', params, undefined)

describe('toPiAgentTools — schema + name boundary', () => {
  it('preserves each namespaced toolset key as the Pi tool name (no re-prefixing) and order', async () => {
    const toolset: Record<string, Tool> = {
      iroh_fs_read: makeTool({ description: 'read a file' }),
      github_create_issue: makeTool({ title: 'Create Issue' }),
      web_search: makeTool({}),
    }

    const pi = await toPiAgentTools(toolset)

    expect(pi.map((t) => t.name)).toEqual(['iroh_fs_read', 'github_create_issue', 'web_search'])
  })

  it('falls back label→name and description→empty-string when absent', async () => {
    const pi = await toPiAgentTools({
      iroh_fs_read: makeTool({ description: 'read a file', title: 'Read File' }),
      bare_tool: makeTool({}),
    })

    expect(pi[0]).toMatchObject({ name: 'iroh_fs_read', label: 'Read File', description: 'read a file' })
    // No title → label defaults to the (namespaced) name; no description → ''.
    expect(pi[1]).toMatchObject({ name: 'bare_tool', label: 'bare_tool', description: '' })
  })

  it('passes a JSON-Schema tool input through to Pi parameters UNCHANGED', async () => {
    const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
    const [pi] = await toPiAgentTools({
      iroh_fs_read: makeTool({ inputSchema: jsonSchema(schema as Parameters<typeof jsonSchema>[0]) }),
    })
    // Exact equality (not toMatchObject): the bridge must not mutate the schema.
    expect(pi.parameters).toEqual(schema)
  })

  it('resolves a Zod (FlexibleSchema) tool input to JSON Schema for Pi parameters', async () => {
    const [pi] = await toPiAgentTools({
      iroh_fs_read: makeTool({ inputSchema: z.object({ path: z.string() }) as unknown as Tool['inputSchema'] }),
    })
    expect(pi.parameters).toMatchObject({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    })
  })
})

describe('toPiAgentTools — execute routing + result mapping', () => {
  it('throws when the underlying tool has no execute function', async () => {
    const [pi] = await toPiAgentTools({ iroh_fs_read: makeTool({}) })
    await expect(runPiTool(pi, {})).rejects.toThrow(/Cannot run tool "iroh_fs_read": it has no execute function/)
  })

  it('passes the namespaced call through to execute and returns content + raw details', async () => {
    let seenParams: unknown
    let seenOptions: { toolCallId?: string; abortSignal?: AbortSignal } | undefined
    const [pi] = await toPiAgentTools({
      github_create_issue: makeTool({
        execute: async (params, options) => {
          seenParams = params
          seenOptions = options
          return { id: 42 }
        },
      }),
    })

    const signal = new AbortController().signal
    const result = await pi.execute('call-1', { title: 'bug' }, signal)

    expect(seenParams).toEqual({ title: 'bug' })
    // The Pi calling convention is bridged onto the AI-SDK options object.
    expect(seenOptions?.toolCallId).toBe('call-1')
    expect(seenOptions?.abortSignal).toBe(signal)
    // No toModelOutput → JSON dump of the raw output as a single text block.
    expect(result).toEqual({ content: [{ type: 'text', text: '{"id":42}' }], details: { id: 42 } })
  })

  it('coerces an undefined output with no toModelOutput to the string "null"', async () => {
    const [pi] = await toPiAgentTools({ t: makeTool({ execute: async () => undefined }) })
    const result = (await runPiTool(pi, {})) as { content: Array<{ type: string; text: string }> }
    expect(result.content).toEqual([{ type: 'text', text: 'null' }])
  })

  it('uses the final chunk of an async-iterable (streaming) execute result', async () => {
    async function* stream() {
      yield { partial: 1 }
      yield { partial: 2 }
      yield { final: true }
    }
    const [pi] = await toPiAgentTools({ t: makeTool({ execute: () => stream() as ReturnType<ToolExecute> }) })

    const result = (await runPiTool(pi, {})) as { details: unknown }
    expect(result.details).toEqual({ final: true })
  })

  it('treats an EMPTY async-iterable result as a "null" output (no final chunk)', async () => {
    async function* empty() {
      // yields nothing
    }
    const [pi] = await toPiAgentTools({ t: makeTool({ execute: () => empty() as ReturnType<ToolExecute> }) })

    const result = (await runPiTool(pi, {})) as { content: Array<{ type: string; text: string }>; details: unknown }
    expect(result.details).toBeUndefined()
    expect(result.content).toEqual([{ type: 'text', text: 'null' }])
  })
})

describe('toPiAgentTools — toModelOutput content branches', () => {
  const convert = async (toModelOutput: ToModelOutput, output: unknown) => {
    const [pi] = await toPiAgentTools({
      t: makeTool({ execute: async () => output, toModelOutput }),
    })
    return (await runPiTool(pi, {})) as {
      content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
    }
  }

  it('maps text / error-text to a text block verbatim', async () => {
    expect((await convert(() => ({ type: 'text', value: 'hello' }), {})).content).toEqual([
      { type: 'text', text: 'hello' },
    ])
    expect((await convert(() => ({ type: 'error-text', value: 'boom' }), {})).content).toEqual([
      { type: 'text', text: 'boom' },
    ])
  })

  it('JSON-stringifies json / error-json values into a text block', async () => {
    expect((await convert(() => ({ type: 'json', value: { a: 1 } }), {})).content).toEqual([
      { type: 'text', text: '{"a":1}' },
    ])
    expect((await convert(() => ({ type: 'error-json', value: [1, 2] }), {})).content).toEqual([
      { type: 'text', text: '[1,2]' },
    ])
  })

  it('coerces an unserialisable json value (stringify→undefined) to "null"', async () => {
    // JSON.stringify(undefined) === undefined; the ?? 'null' guard must keep it a string.
    const denied = await convert(() => ({ type: 'json', value: undefined as unknown as null }), {})
    expect(denied.content).toEqual([{ type: 'text', text: 'null' }])
  })

  it('maps execution-denied to its reason, falling back ONLY for null/undefined (?? not ||)', async () => {
    expect((await convert(() => ({ type: 'execution-denied', reason: 'nope' }), {})).content).toEqual([
      { type: 'text', text: 'nope' },
    ])
    expect((await convert(() => ({ type: 'execution-denied' }), {})).content).toEqual([
      { type: 'text', text: 'Tool execution was denied.' },
    ])
    // `??` (not `||`): an empty-string reason is a real value and must NOT fall back.
    expect((await convert(() => ({ type: 'execution-denied', reason: '' }), {})).content).toEqual([
      { type: 'text', text: '' },
    ])
  })

  it('maps a content array: text→text, image-data/media→image, image file-data→image, non-image file-data→text', async () => {
    const result = await convert(
      () => ({
        type: 'content',
        value: [
          { type: 'text', text: 'caption' },
          { type: 'image-data', data: 'AAA', mediaType: 'image/png' },
          { type: 'media', data: 'BBB', mediaType: 'image/jpeg' },
          { type: 'file-data', data: 'CCC', mediaType: 'image/gif' },
          { type: 'file-data', data: 'DDD', mediaType: 'application/pdf' },
        ],
      }),
      {},
    )

    expect(result.content).toEqual([
      { type: 'text', text: 'caption' },
      { type: 'image', data: 'AAA', mimeType: 'image/png' },
      { type: 'image', data: 'BBB', mimeType: 'image/jpeg' },
      { type: 'image', data: 'CCC', mimeType: 'image/gif' },
      { type: 'text', text: '{"type":"file-data","data":"DDD","mediaType":"application/pdf"}' },
    ])
  })

  it('falls the default content-item branch (e.g. file-url) through to a JSON text dump', async () => {
    const result = await convert(() => ({ type: 'content', value: [{ type: 'file-url', url: 'https://x/y.pdf' }] }), {})
    expect(result.content).toEqual([{ type: 'text', text: '{"type":"file-url","url":"https://x/y.pdf"}' }])
  })
})

describe('toPiAgentTools — never-mask MCP error contract', () => {
  it('throws (does not return a result) when the raw output is an MCP { isError: true }', async () => {
    const [pi] = await toPiAgentTools({
      iroh_fs_read: makeTool({
        // The AI-SDK MCP client RETURNS this rather than throwing; toModelOutput
        // drops the isError flag, so the bridge must detect it on the raw output.
        execute: async () => ({ isError: true, content: [{ type: 'text', text: 'file not found' }] }),
        toModelOutput: () => ({ type: 'error-text', value: 'file not found' }),
      }),
    })

    await expect(runPiTool(pi, {})).rejects.toThrow('file not found')
  })

  it('surfaces an image-only error result as a "[image]" placeholder throw', async () => {
    const [pi] = await toPiAgentTools({
      iroh_fs_read: makeTool({
        execute: async () => ({ isError: true }),
        toModelOutput: () => ({ type: 'content', value: [{ type: 'image-data', data: 'X', mediaType: 'image/png' }] }),
      }),
    })

    await expect(runPiTool(pi, {})).rejects.toThrow('[image]')
  })

  it('throws a generic message when the error output yields empty text', async () => {
    const [pi] = await toPiAgentTools({
      iroh_fs_read: makeTool({
        execute: async () => ({ isError: true }),
        toModelOutput: () => ({ type: 'error-text', value: '' }),
      }),
    })

    await expect(runPiTool(pi, {})).rejects.toThrow('Tool "iroh_fs_read" returned an error.')
  })

  it('does NOT throw when isError is falsy — a normal success result flows through', async () => {
    const [pi] = await toPiAgentTools({
      t: makeTool({
        execute: async () => ({ isError: false, ok: 1 }),
        toModelOutput: () => ({ type: 'text', value: 'done' }),
      }),
    })

    await expect(runPiTool(pi, {})).resolves.toMatchObject({ content: [{ type: 'text', text: 'done' }] })
  })

  it('only treats EXACTLY `isError === true` as an error (truthy non-true does not throw)', async () => {
    const [pi] = await toPiAgentTools({
      t: makeTool({
        // A truthy-but-non-boolean isError must NOT be misread as the MCP error flag.
        execute: async () => ({ isError: 1, ok: true }),
        toModelOutput: () => ({ type: 'text', value: 'fine' }),
      }),
    })

    await expect(runPiTool(pi, {})).resolves.toMatchObject({ content: [{ type: 'text', text: 'fine' }] })
  })
})
