/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { type RenderHtmlOutput, renderHtmlTool } from './render-html-tool'

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
