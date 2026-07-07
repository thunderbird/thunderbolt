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

  it('parses a module script (no import) without flagging it', async () => {
    const html = page('', '<script type="module">export const x = 1; document.title = String(x)</script>')
    expect(await staticCheckHtml(html)).toEqual([])
  })

  it('flags a module script that imports from a CDN as a blocked resource', async () => {
    const specifier = 'https://cdn.skypack.dev/canvas-confetti'
    const issues = await staticCheckHtml(page('', `<script type="module">import confetti from "${specifier}"</script>`))
    const resource = issues.find((i) => i.source === 'resource')
    expect(resource?.message).toContain(specifier)
  })

  it('flags a relative module import too (nothing resolves offline)', async () => {
    const html = page('', '<script type="module">import { x } from "./x.js"; console.log(x)</script>')
    const issues = await staticCheckHtml(html)
    expect(issues.some((i) => i.source === 'resource')).toBe(true)
  })

  it('flags a dynamic import() with a string literal specifier', async () => {
    const specifier = 'https://cdn.example.com/lib.js'
    const issues = await staticCheckHtml(page('', `<script>import("${specifier}").then(() => {})</script>`))
    const resource = issues.find((i) => i.source === 'resource')
    expect(resource?.message).toContain(specifier)
  })

  it('flags external scripts and stylesheets as blocked resources (offline artifacts must inline)', async () => {
    const scriptIssues = await staticCheckHtml(page('', '<script src="https://cdn.example.com/lib.js"></script>'))
    expect(scriptIssues).toHaveLength(1)
    expect(scriptIssues[0]?.source).toBe('resource')
    expect(scriptIssues[0]?.message).toContain('offline')

    const linkIssues = await staticCheckHtml(page('<link rel="stylesheet" href="https://cdn.example.com/a.css">', ''))
    expect(linkIssues.some((i) => i.source === 'resource')).toBe(true)

    // Protocol-relative is external too.
    const protoRel = await staticCheckHtml(page('', '<script src="//cdn.example.com/lib.js"></script>'))
    expect(protoRel[0]?.source).toBe('resource')
  })

  it('flags a relative or root-path script src (the offline CSP blocks every scheme, not just http)', async () => {
    const relative = await staticCheckHtml(page('', '<script src="./app.js"></script>'))
    expect(relative[0]?.source).toBe('resource')

    const rooted = await staticCheckHtml(page('<link rel="stylesheet" href="/styles.css">', ''))
    expect(rooted.some((i) => i.source === 'resource')).toBe(true)
  })

  it('does not flag inline scripts or data: image URIs as external resources', async () => {
    const html = page(
      '<style>.a{color:red}</style>',
      '<script>const x = 1; void x</script><img src="data:image/gif;base64,AAAA">',
    )
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

  it('checks scripts with legacy-but-executable JS MIME types (e.g. text/ecmascript)', async () => {
    const html = page('', '<script type="text/ecmascript">const x = ;</script>')
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
