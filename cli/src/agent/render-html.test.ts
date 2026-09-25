/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { renderHtmlToolName as appRenderHtmlToolName } from '../../../src/artifacts/constants.ts'
import { createRenderHtmlTool, maxArtifactBytes, renderHtmlToolName, staticArtifactIssues } from './render-html.ts'

const page = (body: string): string => `<!doctype html><html><body>${body}</body></html>`

/** Runs the tool and returns its `details`, which is what the ACP layer
 *  forwards as `rawOutput` and the client reads the verdict from. */
const run = async (html: string) => {
  const result = await createRenderHtmlTool().execute('call-1', { html, title: 'Chart' }, undefined)
  return result.details
}

describe('render_html tool', () => {
  test('uses the name the app recognises an artifact by', () => {
    // The app keys artifact rendering on the tool name alone, so a rename on
    // either side turns every hosted artifact back into a plain tool call.
    expect(renderHtmlToolName).toBe(appRenderHtmlToolName)
    expect(createRenderHtmlTool().name).toBe(appRenderHtmlToolName)
  })

  test('accepts a self-contained page', async () => {
    expect(await run(page('<svg width="10" height="10"><rect width="10" height="10"/></svg>'))).toEqual({ ok: true })
  })

  test('reports the verdict under `details`, not at the top level', async () => {
    const result = await createRenderHtmlTool().execute('call-1', { html: page('<p>hi</p>'), title: 'T' }, undefined)
    // `renderHtmlOutput` in the app unwraps `details`; asserting the shape here
    // keeps the two halves of that contract honest.
    expect(result.details).toEqual({ ok: true })
    expect(result.content[0]).toMatchObject({ type: 'text' })
  })

  test('rejects an external script and names the fix', async () => {
    const verdict = await run(page('<script src="https://cdn.example.com/chart.js"></script>'))
    expect(verdict).toMatchObject({ ok: false })
    expect(verdict.ok === false && verdict.errors[0]).toContain('data: URI')
  })

  test.each([
    ['protocol-relative src', '<img src="//example.com/a.png">'],
    ['stylesheet href', '<link rel="stylesheet" href="https://example.com/a.css">'],
    ['css url()', '<style>body{background:url(https://example.com/a.png)}</style>'],
    ['remote import', '<script type="module">import x from "https://example.com/m.js"</script>'],
    ['fetch call', '<script>fetch("https://example.com/data.json")</script>'],
  ])('rejects %s', async (_label, body) => {
    expect(await run(page(body))).toMatchObject({ ok: false })
  })

  test('allows an absolute URL in visible copy', async () => {
    // Only fetching positions matter — a URL the user reads is not a broken
    // reference, and rejecting it would block writing about a link at all.
    expect(await run(page('<p>See https://example.com for details</p>'))).toEqual({ ok: true })
  })

  test('rejects empty or markup-free html', () => {
    expect(staticArtifactIssues('   ')).toEqual(['html is empty.'])
    expect(staticArtifactIssues('just text')).toEqual(['html contains no markup.'])
  })

  test('rejects a page over the byte cap', () => {
    const issues = staticArtifactIssues(page('x'.repeat(maxArtifactBytes)))
    expect(issues).toHaveLength(1)
    expect(issues[0]).toContain('artifact limit')
  })

  test('collects every external reference in one pass', () => {
    // One retry should be able to fix all of them, so the tool must not stop at
    // the first problem.
    const issues = staticArtifactIssues(
      page('<img src="https://a.example/x.png"><link href="https://b.example/y.css">'),
    )
    expect(issues).toHaveLength(2)
  })
})
