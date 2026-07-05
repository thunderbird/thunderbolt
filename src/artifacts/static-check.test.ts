/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { staticCheckHtml } from './static-check'

const page = (head: string, body: string) => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`

describe('staticCheckHtml', () => {
  it('passes valid inline JS and CSS', async () => {
    const html = page('<style>.a{color:red}</style>', '<script>const x = 1; document.title = String(x)</script>')
    expect(await staticCheckHtml(html)).toEqual([])
  })

  it('flags a JS syntax error with a source and line', async () => {
    const html = page('', '<script>const x = ;</script>')
    const issues = await staticCheckHtml(html)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.source).toBe('js')
    expect(issues[0]?.line).toBe(1)
  })

  it('flags a CSS syntax error (browsers would silently ignore it)', async () => {
    const html = page('<style>h1 color: red }</style>', '')
    const issues = await staticCheckHtml(html)
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.every((i) => i.source === 'css')).toBe(true)
  })

  it('does not false-flag a module script that uses import', async () => {
    const html = page('', '<script type="module">import { x } from "./x.js"; console.log(x)</script>')
    expect(await staticCheckHtml(html)).toEqual([])
  })

  it('ignores external scripts (cannot statically check remote code)', async () => {
    const html = page('', '<script src="https://cdn.example.com/lib.js"></script>')
    expect(await staticCheckHtml(html)).toEqual([])
  })

  it('skips non-JS scripts (importmap, JSON data island, template) instead of flagging them as bad JS', async () => {
    const html = page(
      '',
      '<script type="importmap">{ "imports": { "x": "/x.js" } }</script>' +
        '<script type="application/json">{ "data": [1, 2, 3] }</script>' +
        '<script type="text/template"><div>{{ name }}</div></script>',
    )
    expect(await staticCheckHtml(html)).toEqual([])
  })

  it('still checks explicitly JS-typed scripts', async () => {
    const html = page('', '<script type="text/javascript">const x = ;</script>')
    const issues = await staticCheckHtml(html)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.source).toBe('js')
  })

  it('aggregates issues across multiple blocks', async () => {
    const html = page('<style>h1 color: red }</style>', '<script>function(</script>')
    const issues = await staticCheckHtml(html)
    expect(issues.some((i) => i.source === 'js')).toBe(true)
    expect(issues.some((i) => i.source === 'css')).toBe(true)
  })

  it('returns no issues for a page with no inline JS or CSS', async () => {
    expect(await staticCheckHtml(page('<title>Hi</title>', '<p>Hello</p>'))).toEqual([])
  })
})
