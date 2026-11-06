/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Converts the app's AI-SDK tools — the `Record<string, Tool>` produced by
 * `src/ai/fetch.ts`'s `mergeMcpTools` (MCP servers' tools, already namespaced
 * `<server>_<tool>`, plus the app's built-in integration tools) — into Pi
 * {@link AgentTool}s so they keep working under the in-browser Pi harness.
 *
 * Two boundaries are bridged:
 *
 *  - **Schema.** An AI-SDK tool carries its input schema as a `FlexibleSchema`
 *    (Zod or JSON Schema). Pi types a tool's `parameters` as a TypeBox `TSchema`,
 *    but its validation layer (`validateToolArguments`) explicitly accepts a
 *    *plain* JSON Schema object that lacks TypeBox metadata — it compiles such a
 *    schema directly and applies JSON-Schema coercion — and its Anthropic tool
 *    serialization reads `.properties`/`.required` straight off the object. So we
 *    resolve the tool's schema to JSON Schema via `asSchema().jsonSchema` and pass
 *    it through unchanged; {@link asPiParameters} only re-brands the structural
 *    type at the FFI boundary.
 *
 *  - **Result.** Pi tools return `{ content, details }` where `content` is a list
 *    of text/image blocks. We run the AI-SDK tool's `execute` and map its output
 *    through the tool's own `toModelOutput` (MCP tools define one) into Pi text /
 *    image content, falling back to a JSON dump when no `toModelOutput` exists.
 *
 * Errors are intentionally left to throw: Pi's agent loop catches a thrown tool
 * error and encodes it as a tool-result error, which is exactly the never-mask
 * behaviour we want — no defensive wrapping here.
 */

import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { ImageContent, TextContent } from '@earendil-works/pi-ai'
import { asSchema, type Tool } from 'ai'

/** Pi's structural type for a tool's `parameters` (a TypeBox `TSchema`). */
type PiToolParameters = AgentTool['parameters']

/** A text or image block in a Pi tool result. */
type PiContent = TextContent | ImageContent

/**
 * Re-brand a resolved JSON Schema as Pi's `parameters` type. Pi accepts plain
 * JSON Schema objects at runtime (see module docs), so the schema flows through
 * unchanged; this only satisfies the structural `TSchema` brand at the boundary.
 */
const asPiParameters = (jsonSchema: object): PiToolParameters => jsonSchema as unknown as PiToolParameters

/** Render any value as a string for text content (passing strings through).
 *  `JSON.stringify` returns `undefined` for `undefined`/functions, so coerce that
 *  to `'null'` (matching the AI SDK) to keep the result a real string. */
const stringify = (value: unknown): string => (typeof value === 'string' ? value : (JSON.stringify(value) ?? 'null'))

/** Whether a tool's raw output is an MCP error result (`{ isError: true }`). The
 *  AI-SDK MCP client returns — rather than throws — such results, and its
 *  `toModelOutput` drops the flag, so we detect it on the raw output. */
const isErrorOutput = (output: unknown): boolean =>
  typeof output === 'object' && output !== null && 'isError' in output && output.isError === true

/** Whether a value is an async iterable (a streaming tool result). */
const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
  typeof value === 'object' && value !== null && Symbol.asyncIterator in value

/**
 * Normalise an AI-SDK `execute` return — which may be a value, a promise, or an
 * async iterable of progressive outputs — to the single final output.
 */
const resolveExecuteOutput = async (raw: unknown): Promise<unknown> => {
  if (isAsyncIterable(raw)) {
    // AI SDK treats every yield as a complete preliminary output and promotes
    // the final yield to the final tool result. Retain only that final state.
    let finalOutput: unknown
    for await (const chunk of raw) {
      finalOutput = chunk
    }
    return finalOutput
  }
  return await raw
}

/**
 * Map an AI-SDK tool's output to Pi content. Prefers the tool's `toModelOutput`
 * (MCP tools always define one); otherwise dumps the raw output as JSON text.
 */
const toPiContent = async (
  tool: Tool,
  args: { toolCallId: string; input: unknown; output: unknown },
): Promise<PiContent[]> => {
  if (!tool.toModelOutput) {
    return [{ type: 'text', text: stringify(args.output) }]
  }
  const modelOutput = await tool.toModelOutput(args)
  switch (modelOutput.type) {
    case 'text':
    case 'error-text':
      return [{ type: 'text', text: modelOutput.value }]
    case 'json':
    case 'error-json':
      return [{ type: 'text', text: stringify(modelOutput.value) }]
    case 'execution-denied':
      return [{ type: 'text', text: modelOutput.reason ?? 'Tool execution was denied.' }]
    case 'content':
      return modelOutput.value.map((item): PiContent => {
        switch (item.type) {
          case 'text':
            return { type: 'text', text: item.text }
          case 'image-data':
          case 'media':
            return { type: 'image', data: item.data, mimeType: item.mediaType }
          case 'file-data':
            return item.mediaType.startsWith('image/')
              ? { type: 'image', data: item.data, mimeType: item.mediaType }
              : { type: 'text', text: stringify(item) }
          default:
            return { type: 'text', text: stringify(item) }
        }
      })
  }
}

/**
 * Convert a single AI-SDK tool into a Pi {@link AgentTool}. The schema is resolved
 * eagerly (Pi reads `parameters` synchronously when building the provider request).
 */
const toPiAgentTool = async (name: string, tool: Tool): Promise<AgentTool> => {
  const jsonSchema = await Promise.resolve(asSchema(tool.inputSchema).jsonSchema)
  return {
    name,
    label: tool.title ?? name,
    description: tool.description ?? '',
    parameters: asPiParameters(jsonSchema),
    execute: async (toolCallId, params, signal) => {
      const { execute } = tool
      if (!execute) {
        throw new Error(`Cannot run tool "${name}": it has no execute function.`)
      }
      const output = await resolveExecuteOutput(execute(params, { toolCallId, messages: [], abortSignal: signal }))
      const content = await toPiContent(tool, { toolCallId, input: params, output })
      if (isErrorOutput(output)) {
        // Pi tools signal failure by throwing (its loop encodes that as an error
        // tool result, mirroring Anthropic's `is_error`). Surface the MCP error
        // text as a throw rather than masking it as a successful result.
        const text = content.map((part) => (part.type === 'text' ? part.text : '[image]')).join('\n')
        throw new Error(text || `Tool "${name}" returned an error.`)
      }
      return { content, details: output }
    },
  }
}

/**
 * Convert an AI-SDK toolset (e.g. the merged MCP + integration tools) into Pi
 * {@link AgentTool}s, preserving each tool's namespaced name as the Pi tool name.
 *
 * @param toolset - the app's `Record<string, Tool>` (keys are namespaced tool names)
 * @returns the equivalent Pi agent tools, ready to pass to `buildAppHarness({ tools })`
 */
export const toPiAgentTools = async (toolset: Record<string, Tool>): Promise<AgentTool[]> =>
  Promise.all(Object.entries(toolset).map(([name, tool]) => toPiAgentTool(name, tool)))
