/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock, afterEach } from 'bun:test'
import { createNativeToolset, type NativeToolContext } from './native-tools.ts'

const originalFetch = globalThis.fetch

const context: NativeToolContext = {
  backendURL: 'https://cloud.example/v1',
  headers: { Authorization: 'Bearer session', 'X-App-Version': '1.2.3' },
  webEnabled: true,
  webIntent: 'auto',
  skills: [
    { name: 'research', description: 'Research thoroughly', instruction: 'Research with sources.' },
  ],
  projectChats: { projectName: 'Roadmap', threadIds: ['sibling-1'] },
  renderHTML: true,
}

afterEach(() => {
  mock.restore()
  globalThis.fetch = originalFetch
})

describe('native Pi tools', () => {
  it('dispatches MCP tools through native transport and preserves images, errors, ownership, and cancellation', async () => {
    const calls: unknown[] = []
    const signal = new AbortController().signal
    const tools = await createNativeToolset({ ...context, mcpTools: [{
      serverID: 'server-1', serverName: 'Project Docs', serverURL: 'https://docs.example/mcp',
      name: 'project_docs_lookup', toolName: 'lookup', description: 'Find a document',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    }] }, 'scope-1', async (thread, name, args, receivedSignal) => {
      calls.push({ thread, name, args: JSON.parse(args), signal: receivedSignal })
      if (JSON.parse(args).arguments.query === 'error') return { isError: true, content: [{ type: 'text', text: 'Access denied' }] }
      return { content: [{ type: 'text', text: 'Found it' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }] }
    })
    const lookup = tools.tools.find(({ name }) => name === 'project_docs_lookup')!
    const result = await lookup.execute('call', { query: 'plan' }, signal)
    expect(calls).toEqual([{ thread: 'scope-1', name: 'mcp_call_tool', args: {
      serverID: 'server-1', name: 'lookup', arguments: { query: 'plan' },
    }, signal }])
    expect(result.content).toEqual([{ type: 'text', text: 'Found it' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }])
    expect(tools.mcpTools.project_docs_lookup).toEqual({ name: 'Project Docs', url: 'https://docs.example/mcp', toolName: 'lookup' })
    await expect(lookup.execute('failed-call', { query: 'error' }, signal)).rejects.toThrow('Access denied')
  })

  it('does not let an MCP tool replace a built-in tool', async () => {
    const tools = await createNativeToolset({ ...context, mcpTools: [{
      serverID: 'malformed', serverName: 'Bad descriptor', serverURL: 'https://example.com',
      name: 'skill', toolName: 'skill', inputSchema: { type: 'object' },
    }] }, 'scope', async () => { throw new Error('MCP must not replace the skill tool') })
    const skill = tools.tools.find(({ name }) => name === 'skill')!
    const result = await skill.execute('call', { name: 'research' }, new AbortController().signal)
    expect(result.content[0]?.text).toBe('Research with sources.')
    expect(tools.mcpTools).toEqual({})
  })

  it('creates search/fetch, skill, project, and artifact tools from snapshots', async () => {
    const toolset = await createNativeToolset(context, 'current-thread', async () => ({ ok: true }))
    expect(toolset.tools.map(({ name }) => name)).toEqual([
      'search', 'fetch_content', 'skill', 'search_project_chats', 'render_html',
    ])
    expect(toolset.skillListing).toContain('research')
  })

  it('keeps web requests on the backend and reports collected source metadata', async () => {
    const requests: Request[] = []
    globalThis.fetch = async (input) => {
      const request = input instanceof Request ? input : new Request(input)
      requests.push(request)
      if (request.url.endsWith('/search?q=parity&limit=2')) {
        return Response.json({ results: [{
          title: 'Parity notes', pageUrl: 'https://docs.example/parity', faviconUrl: null,
          previewImageUrl: null, snippet: 'Native parity notes',
        }] })
      }
      return Response.json({
        success: true,
        data: {
          url: 'https://docs.example/parity', title: 'Parity notes', text: 'Full notes',
          favicon: null, image: null, author: null,
        },
      })
    }
    const toolset = await createNativeToolset(context, 'current-thread', async () => null)
    const searchTool = toolset.tools.find(({ name }) => name === 'search')
    const fetchTool = toolset.tools.find(({ name }) => name === 'fetch_content')
    if (!searchTool || !fetchTool) throw new Error('web tools were not registered')
    const searchResult = await searchTool.execute('search-call', { query: 'parity', max_results: 2 }, new AbortController().signal)
    await fetchTool.execute('fetch-call', { url: 'https://docs.example/parity' }, new AbortController().signal)
    expect(requests.map(({ url }) => url)).toEqual([
      'https://cloud.example/v1/search?q=parity&limit=2',
      'https://cloud.example/v1/pro/fetch-content',
      'https://cloud.example/v1/preview',
    ])
    expect(requests.every((request) => request.headers.get('authorization') === 'Bearer session')).toBe(true)
    expect(toolset.sourceCollector[0]).toMatchObject({ url: 'https://docs.example/parity', title: 'Parity notes', index: 1 })
    expect(searchResult.content[0]?.text).toContain('[Source 1]')
  })

  it('routes native tools to the scoped Swift handler and promotes research budget', async () => {
    const calls: { threadId: string; name: string; args: string }[] = []
    const toolset = await createNativeToolset(context, 'thread-42', async (threadId, name, argumentsJSON) => {
      calls.push({ threadId, name, args: argumentsJSON })
      return { ok: true }
    })
    const skillTool = toolset.tools.find(({ name }) => name === 'skill')
    const projectTool = toolset.tools.find(({ name }) => name === 'search_project_chats')
    const artifactTool = toolset.tools.find(({ name }) => name === 'render_html')
    if (!skillTool || !projectTool || !artifactTool) throw new Error('local tools were not registered')
    await skillTool.execute('skill-call', { name: '/research' }, new AbortController().signal)
    await projectTool.execute('project-call', { query: 'pricing' }, new AbortController().signal)
    await artifactTool.execute('artifact-call', { html: '<html/>', title: 'Diagram' }, new AbortController().signal)
    expect(toolset.budget.cap).toBe(30)
    expect(calls).toEqual([
      { threadId: 'thread-42', name: 'search_project_chats', args: '{"query":"pricing","match":"\\"pricing\\"*","substrings":[]}' },
      { threadId: 'thread-42', name: 'render_html', args: '{"html":"<html/>","title":"Diagram"}' },
    ])
  })
})
