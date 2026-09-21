/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { type RenderHtmlOutput, type RenderHtmlPart, renderHtmlOutput, renderHtmlTool } from './render-html-tool'

const exec = (input: { html: string; title: string }) => renderHtmlTool.execute(input) as Promise<RenderHtmlOutput>

describe('renderHtmlTool', () => {
  it('exposes a stable name and a schema requiring html + title', () => {
    expect(renderHtmlTool.name).toBe('render_html')
    expect(() => renderHtmlTool.parameters.parse({ html: '<p>x</p>', title: 'X' })).not.toThrow()
    expect(() => renderHtmlTool.parameters.parse({ title: 'no html' })).toThrow()
    expect(() => renderHtmlTool.parameters.parse({ html: '<p>x</p>' })).toThrow()
  })

  // The success path renders in a real iframe (covered by verify-html tests + the
  // app run). The failure path short-circuits on static checks before any iframe,
  // so it is deterministic here.
  it('returns ok:false with the syntax error when the artifact has invalid JS', async () => {
    const result = await exec({
      html: '<!doctype html><html><body><script>const x = ;</script></body></html>',
      title: 'Broken',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]).toContain('Invalid JS')
    }
  })
})

/** A finished `render_html` part carrying whatever the agent returned. */
const finishedPart = (output: unknown): RenderHtmlPart =>
  ({ type: 'tool-render_html', toolCallId: 'call-1', state: 'output-available', input: {}, output }) as RenderHtmlPart

describe('renderHtmlOutput', () => {
  it('reads the verdict from the built-in agent shape', () => {
    expect(renderHtmlOutput(finishedPart({ ok: true }))).toEqual({ ok: true })
    expect(renderHtmlOutput(finishedPart({ ok: false, errors: ['boom'] }))).toEqual({ ok: false, errors: ['boom'] })
  })

  it('unwraps the pi AgentToolResult a remote ACP agent returns', () => {
    // `cli/src/acp/harness-to-acp.ts` forwards the whole `{content, details}`
    // result as `rawOutput`, so a hosted agent's verdict sits under `details`.
    // Reading only the top level left every hosted artifact rendering as a
    // plain tool call.
    expect(
      renderHtmlOutput(finishedPart({ content: [{ type: 'text', text: 'done' }], details: { ok: true } })),
    ).toEqual({ ok: true })
  })

  it('returns undefined when no verdict is present in either position', () => {
    expect(renderHtmlOutput(finishedPart(undefined))).toBeUndefined()
    expect(renderHtmlOutput(finishedPart('done'))).toBeUndefined()
    expect(renderHtmlOutput(finishedPart({ content: [] }))).toBeUndefined()
    expect(renderHtmlOutput(finishedPart({ details: { note: 'no ok field' } }))).toBeUndefined()
  })
})
