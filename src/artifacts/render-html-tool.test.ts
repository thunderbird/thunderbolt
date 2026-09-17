/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  type RenderHtmlOutput,
  type RenderHtmlPart,
  renderHtmlInput,
  renderHtmlOutput,
  renderHtmlTool,
} from './render-html-tool'

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

describe('renderHtmlOutput', () => {
  const part = (output: unknown) => ({ output }) as RenderHtmlPart

  it('reads the bare result', () => {
    expect(renderHtmlOutput(part({ ok: true }))).toEqual({ ok: true })
  })

  it('reads a failure with its errors', () => {
    expect(renderHtmlOutput(part({ ok: false, errors: ['boom'] }))).toEqual({ ok: false, errors: ['boom'] })
  })

  /*
   * The exact shape a provider returned for DeepSeek V4 Flash while GLM 5.2 got
   * the bare object. `part.output as RenderHtmlOutput` accepted it — a cast
   * cannot fail — and `.ok` came back `undefined`, so a verified artifact was
   * judged unverified and rendered as nothing at all.
   */
  it('unwraps the MCP-style envelope some providers add', () => {
    const wrapped = {
      content: [{ type: 'text', text: '{"ok":true}' }],
      details: { ok: true },
    }
    expect(renderHtmlOutput(part(wrapped))).toEqual({ ok: true })
  })

  it('falls back to the serialised text block when details are absent', () => {
    const wrapped = { content: [{ type: 'text', text: '{"ok":false,"errors":["bad css"]}' }] }
    expect(renderHtmlOutput(part(wrapped))).toEqual({ ok: false, errors: ['bad css'] })
  })

  it('returns undefined before the tool has finished', () => {
    expect(renderHtmlOutput(part(undefined))).toBeUndefined()
  })

  /** Must degrade, not throw — this runs during render. */
  it('returns undefined for a text block that is not JSON', () => {
    expect(renderHtmlOutput(part({ content: [{ type: 'text', text: 'rendered!' }] }))).toBeUndefined()
  })
})

/*
 * The input twin of the cast that cost a day on the output side. Absent fields
 * are normal here — the input streams in — but a cast says nothing about a
 * field that is present and the wrong type, and callers go straight to
 * `html.match(…)` and `title?.trim()` during render.
 */
describe('renderHtmlInput', () => {
  const part = (input: unknown) => ({ input }) as RenderHtmlPart

  it('reads a complete input', () => {
    expect(renderHtmlInput(part({ html: '<p>x</p>', title: 'X' }))).toEqual({ html: '<p>x</p>', title: 'X' })
  })

  it('reads a half-streamed input without inventing fields', () => {
    expect(renderHtmlInput(part({ html: '<p>x' }))).toEqual({ html: '<p>x' })
  })

  it('treats a missing input as still streaming', () => {
    expect(renderHtmlInput(part(undefined))).toEqual({})
  })

  it('drops a wrong-typed field rather than handing a caller a number to .trim()', () => {
    expect(renderHtmlInput(part({ html: '<p>x</p>', title: 7 }))).toEqual({ html: '<p>x</p>' })
  })

  it('degrades to empty for an input that is not an object at all', () => {
    expect(renderHtmlInput(part('<p>x</p>'))).toEqual({})
  })
})
