/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { createRenderHtmlTool, registerRenderHtmlTool, renderHtmlResult, type ToolHost } from './render-html-tool.ts'

const validPage = '<!doctype html><html><head><style>.a{color:red}</style></head><body><script>void 0</script></body></html>'

const run = (html: string, title = 'Chart') => renderHtmlResult({ html, title })

const inertTool = (name: string): AgentTool => ({
  name,
  label: name,
  description: name,
  parameters: Type.Object({}),
  execute: async () => ({ content: [], details: null }),
})

/** Minimal stand-in for the harness's tool registry. */
const createToolHost = (initial: string[]): ToolHost & { active: string[] } => {
  const state = { tools: initial.map(inertTool), active: initial }
  return {
    get active() {
      return state.active
    },
    getTools: () => state.tools,
    setTools: async (tools, activeToolNames) => {
      state.tools = tools
      state.active = activeToolNames ?? state.active
    },
  }
}

describe('createRenderHtmlTool', () => {
  it('exposes the shared tool name and an html/title schema', () => {
    const tool = createRenderHtmlTool()
    expect(tool.name).toBe('render_html')
    expect(Object.keys(tool.parameters.properties)).toEqual(['html', 'title'])
    expect([...tool.parameters.required]).toContainAllValues(['html', 'title'])
  })

  it('describes validation honestly: static checks here, rendering when displayed', () => {
    const { description } = createRenderHtmlTool()
    expect(description).toContain('statically checked')
    expect(description).toContain('NOT executed here')
  })

  it('validates the page it is called with', async () => {
    const result = await createRenderHtmlTool().execute('call-1', { html: validPage, title: 'Chart' })
    expect(result).toMatchObject({ ok: true, details: { title: 'Chart' } })
  })
})

describe('renderHtmlResult', () => {
  it('returns ok for a self-contained page and keeps the title in details', () => {
    const result = run(validPage, 'Sales dashboard')
    expect(result.ok).toBe(true)
    expect(result.details).toEqual({ title: 'Sales dashboard' })
  })

  it('returns the static errors instead of throwing, so the model can call again', () => {
    const result = run('<html><body><script>const x = ;</script></body></html>')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]).toContain('Invalid JS')
    // Surfaced to the model as text too, not just as structured output.
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Invalid JS') })
  })

  it('reports every problem in one pass', () => {
    const result = run(
      '<html><head><style>h1 color: red }</style><link rel="stylesheet" href="/a.css"></head>' +
        '<body><script>function(</script></body></html>',
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.length).toBeGreaterThanOrEqual(3)
  })
})

describe('registerRenderHtmlTool', () => {
  it('appends render_html to the harness toolset and marks every tool active', async () => {
    const host = createToolHost(['read', 'write'])
    await registerRenderHtmlTool(host)
    expect(host.getTools().map((tool) => tool.name)).toEqual(['read', 'write', 'render_html'])
    expect(host.active).toEqual(['read', 'write', 'render_html'])
  })
})
