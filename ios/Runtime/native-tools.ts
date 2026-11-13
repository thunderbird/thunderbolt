/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { jsonSchema, tool, type Tool } from 'ai'
import { createWebToolBudget, type WebToolIntent } from '../../src/ai/web-tool-budget.ts'
import { fetchContent, fetchLinkPreview, search } from '../../src/integrations/thunderbolt-pro/api.ts'
import { createConfigs } from '../../src/integrations/thunderbolt-pro/tools-core.ts'
import type { HttpClient, RequestOptions, ResponsePromise } from '../../src/lib/http.ts'
import type { SourceMetadata } from '../../src/types/source.ts'
import { buildSkillListing, resolveSkill, type SkillDefinition } from '../../shared/agent-core/skills.ts'
import { resolveSkillWebToolIntent } from '../../src/ai/turn-web-budget.ts'
import { planSearchQuery } from '../../src/search/query-plan.ts'
import { toPiAgentTools } from '../../shared/agent-core/mcp-tools.ts'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { z } from 'zod'

export type NativeToolContext = {
  backendURL: string
  headers: Record<string, string>
  webEnabled: boolean
  webIntent: WebToolIntent
  skills: SkillDefinition[]
  projectChats?: { projectName: string; threadIds: string[] }
  renderHTML?: boolean
  mcpTools?: NativeMCPToolDescriptor[]
}

type NativeMCPToolDescriptor = {
  serverID: string
  serverName: string
  serverURL: string
  name: string
  toolName: string
  description?: string | null
  inputSchema: Record<string, unknown>
}

export type NativeToolset = {
  tools: AgentTool[]
  sourceCollector: SourceMetadata[]
  budget: ReturnType<typeof createWebToolBudget>
  skillListing?: string
  mcpTools: Record<string, { name: string; url: string; toolName: string }>
}

/** Render MCP text, images and embedded resources without fetching external URLs. */
const mcpModelContent = (output: unknown) => {
  const record = output && typeof output === 'object' ? output as Record<string, unknown> : {}
  const blocks = Array.isArray(record.content) ? record.content as unknown[] : []
  const content: ({ type: 'text'; text: string } | { type: 'image-data'; data: string; mediaType: string })[] = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    const part = block as Record<string, unknown>
    if (part.type === 'text' && typeof part.text === 'string') content.push({ type: 'text', text: part.text })
    else if (part.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string') {
      content.push({ type: 'image-data', data: part.data, mediaType: part.mimeType })
    } else if (part.type === 'resource' && part.resource && typeof part.resource === 'object' &&
               'text' in part.resource && typeof part.resource.text === 'string') {
      content.push({ type: 'text', text: part.resource.text })
    } else content.push({ type: 'text', text: JSON.stringify(part) })
  }
  if (record.structuredContent !== undefined && content.length === 0) {
    content.push({ type: 'text', text: JSON.stringify(record.structuredContent) })
  }
  return content
}

const createHttpClient = (backendURL: string, headers: Record<string, string>): HttpClient => {
  const baseURL = new URL(backendURL.endsWith('/') ? backendURL : `${backendURL}/`)
  const request = (method: string, path: string, options: RequestOptions = {}): ResponsePromise => {
    const url = new URL(path, baseURL)
    if (url.origin !== baseURL.origin) throw new Error('Native tools can only access the configured backend')
    if (options.searchParams) {
      const params = options.searchParams instanceof URLSearchParams
        ? options.searchParams
        : new URLSearchParams(Object.entries(options.searchParams).flatMap(([key, value]) => value === undefined ? [] : [[key, String(value)]]))
      params.forEach((value, key) => url.searchParams.set(key, value))
    }
    const requestHeaders = new Headers(headers)
    new Headers(options.headers).forEach((value, key) => requestHeaders.set(key, value))
    let body: BodyInit | undefined
    if (options.json !== undefined) {
      requestHeaders.set('Content-Type', 'application/json')
      body = JSON.stringify(options.json)
    } else {
      body = options.body
    }
    const timeoutController = options.timeout ? new AbortController() : undefined
    const timeout = options.timeout && timeoutController
      ? setTimeout(() => timeoutController.abort(new Error('Request timed out')), options.timeout)
      : undefined
    const signal = timeoutController
      ? options.signal ? AbortSignal.any([options.signal, timeoutController.signal]) : timeoutController.signal
      : options.signal
    const response = globalThis.fetch(new Request(url, { method, headers: requestHeaders, body, signal }))
      .then((result) => {
        if (!result.ok) throw new Error(`Request failed with status ${result.status}`)
        return result
      })
      .finally(() => { if (timeout !== undefined) clearTimeout(timeout) })
    const result = response as ResponsePromise
    result.json = <T>() => response.then((value) => value.json() as Promise<T>)
    result.text = () => response.then((value) => value.text())
    return result
  }
  return {
    get: (path, options) => request('GET', path, options),
    post: (path, options) => request('POST', path, options),
    delete: (path, options) => request('DELETE', path, options),
  }
}

/** Build the per-turn hosted web and skill tools for a native Pi harness. */
export const createNativeToolset = async (
  context: NativeToolContext,
  threadId: string,
  executeLocalTool: (threadId: string, name: string, argumentsJSON: string, signal?: AbortSignal) => Promise<unknown>,
): Promise<NativeToolset> => {
  const sourceCollector: SourceMetadata[] = []
  const budget = createWebToolBudget(context.webIntent)
  const configs = context.webEnabled
    ? createConfigs(createHttpClient(context.backendURL, context.headers), sourceCollector, { search, fetchContent, fetchLinkPreview })
    : []
  const webTools = Object.fromEntries(configs.map((config) => [config.name, tool({
    description: config.description,
    inputSchema: config.parameters,
    toModelOutput: ({ output }) => ({
      type: 'content' as const,
      value: [{ type: 'text' as const, text: JSON.stringify(output) }, {
        type: 'text' as const,
        text: `Web calls remaining this turn: ${Math.max(0, budget.cap - budget.consumed)}.${budget.probe.isExhausted ? ' Synthesize now from the available evidence; do not call web tools again.' : ''}`,
      }],
    }),
    execute: (input: unknown) => budget.execute(config.name, input, () => config.execute(input)),
  })]))

  const skillTool = context.skills.length === 0 ? {} : {
    skill: tool({
      description: 'Load full instructions for an enabled skill. Use the exact skill name from the system prompt skill list.',
      inputSchema: z.object({ name: z.string().describe('Skill name or slash-prefixed slug from the system prompt skill list') }),
      execute: async ({ name }) => {
        const skill = resolveSkill(context.skills, name)
        if (!skill) throw new Error(`Skill "${name}" was not found or is disabled.`)
        if (skill.instruction.trim()) budget.promote(resolveSkillWebToolIntent(skill.name))
        return skill.instruction
      },
    }),
  }
  const localTools = {
    ...(context.projectChats && context.projectChats.threadIds.length > 0 ? {
      search_project_chats: tool({
        description: `Search earlier conversations in the "${context.projectChats.projectName}" project for something the user already discussed. This is KEYWORD search over message text — it matches words, not meaning, so a query using different vocabulary than the original conversation will return nothing. If the first search comes up empty, try again with synonyms and related terms before concluding the topic was never discussed (e.g. "pricing" → "price", "cost", "charge", "revenue"). Does not search the current chat.`,
        inputSchema: z.object({ query: z.string().describe('Keywords to look for. Prefer distinctive nouns over full sentences.') }),
        execute: async (input: { query: string }, options) => executeLocalTool(
          threadId, 'search_project_chats', JSON.stringify({ query: input.query, ...planSearchQuery(input.query) }), options.abortSignal,
        ),
      }),
    } : {}),
    ...(context.renderHTML ? {
      render_html: tool({
        description: 'Render a self-contained HTML page (HTML/CSS/JS) as a visual artifact the user can see, instead of describing it in prose. Use this whenever a visual or interactive result is more useful than text: charts and data visualizations, diagrams, dashboards, formatted layouts, animations, simulations, games, or small web apps. Do NOT use it to reproduce something a built-in widget already renders. The page is verified before display; if the result is { ok: false }, read the errors, fix the HTML, and call render_html again. Do not narrate the HTML source to the user.',
        inputSchema: z.object({ html: z.string().describe('A complete, self-contained HTML document. Inline CSS and JS. External resources and network access are blocked.'), title: z.string().describe('A short, human-readable title for the artifact.') }),
        execute: async (input: { html: string; title: string }, options) => executeLocalTool(
          threadId, 'render_html', JSON.stringify(input), options.abortSignal,
        ),
      }),
    } : {}),
  }
  const merged: Record<string, Tool> = { ...webTools, ...skillTool, ...localTools }
  const mcpTools: NativeToolset['mcpTools'] = {}
  for (const descriptor of context.mcpTools ?? []) {
    if (Object.hasOwn(merged, descriptor.name)) continue
    merged[descriptor.name] = tool({
      description: descriptor.description ?? '',
      inputSchema: jsonSchema(descriptor.inputSchema),
      execute: async (input, options) => executeLocalTool(threadId, 'mcp_call_tool', JSON.stringify({
        serverID: descriptor.serverID, name: descriptor.toolName, arguments: input,
      }), options.abortSignal),
      toModelOutput: ({ output }) => ({ type: 'content', value: mcpModelContent(output) }),
    })
    mcpTools[descriptor.name] = { name: descriptor.serverName, url: descriptor.serverURL, toolName: descriptor.toolName }
  }
  return {
    tools: await toPiAgentTools(merged),
    sourceCollector,
    budget,
    skillListing: buildSkillListing(context.skills),
    mcpTools,
  }
}
