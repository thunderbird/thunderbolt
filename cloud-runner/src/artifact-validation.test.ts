/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { extractInlineBlocks, staticCheckHtml, validateArtifactHtml } from './artifact-validation.ts'

const page = (head: string, body: string) => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`

describe('extractInlineBlocks', () => {
  it('reads raw script and style bodies without treating their contents as markup', () => {
    const blocks = extractInlineBlocks(page('<style>.a::after{content:"<b>"}</style>', '<script>if (1 < 2) {}</script>'))
    expect(blocks.styles).toEqual(['.a::after{content:"<b>"}'])
    expect(blocks.scripts).toEqual([{ code: 'if (1 < 2) {}', module: false }])
  })

  it('marks module scripts so import syntax parses', () => {
    const blocks = extractInlineBlocks(page('', '<script type="MODULE">export const x = 1</script>'))
    expect(blocks.scripts[0]?.module).toBe(true)
  })

  it('skips empty and non-JS scripts', () => {
    const blocks = extractInlineBlocks(
      page('', '<script></script><script type="application/json">{"a":1}</script><script>void 0</script>'),
    )
    expect(blocks.scripts).toEqual([{ code: 'void 0', module: false }])
  })

  it('still checks a block left unclosed by a truncated document', () => {
    expect(extractInlineBlocks('<html><head><style>h1 color: red')).toMatchObject({
      styles: ['h1 color: red'],
    })
  })
})

describe('staticCheckHtml', () => {
  it('passes valid inline JS and CSS', () => {
    const html = page('<style>.a{color:red}</style>', '<script>const x = 1; document.title = String(x)</script>')
    expect(staticCheckHtml(html)).toEqual([])
  })

  it('flags a JS syntax error with a source and line', () => {
    const issues = staticCheckHtml(page('', '<script>const x = ;</script>'))
    expect(issues).toHaveLength(1)
    expect(issues[0]?.source).toBe('js')
    expect(issues[0]?.line).toBe(1)
  })

  it('flags a CSS syntax error (browsers would silently ignore it)', () => {
    const issues = staticCheckHtml(page('<style>h1 color: red }</style>', ''))
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.every((issue) => issue.source === 'css')).toBe(true)
  })

  it('parses a module script (no import) without flagging it', () => {
    const html = page('', '<script type="module">export const x = 1; document.title = String(x)</script>')
    expect(staticCheckHtml(html)).toEqual([])
  })

  it('flags a module script that imports from a CDN as a blocked resource', () => {
    const specifier = 'https://cdn.skypack.dev/canvas-confetti'
    const issues = staticCheckHtml(page('', `<script type="module">import confetti from "${specifier}"</script>`))
    expect(issues.find((issue) => issue.source === 'resource')?.message).toContain(specifier)
  })

  it('flags a relative module import too (nothing resolves offline)', () => {
    const html = page('', '<script type="module">import { x } from "./x.js"; console.log(x)</script>')
    expect(staticCheckHtml(html).some((issue) => issue.source === 'resource')).toBe(true)
  })

  it('flags a dynamic import() with a string literal specifier', () => {
    const specifier = 'https://cdn.example.com/lib.js'
    const issues = staticCheckHtml(page('', `<script>import("${specifier}").then(() => {})</script>`))
    expect(issues.find((issue) => issue.source === 'resource')?.message).toContain(specifier)
  })

  it('flags external scripts and stylesheets as blocked resources', () => {
    const scriptIssues = staticCheckHtml(page('', '<script src="https://cdn.example.com/lib.js"></script>'))
    expect(scriptIssues).toHaveLength(1)
    expect(scriptIssues[0]?.source).toBe('resource')
    expect(scriptIssues[0]?.message).toContain('offline')

    const linkIssues = staticCheckHtml(page('<link rel="stylesheet" href="https://cdn.example.com/a.css">', ''))
    expect(linkIssues.some((issue) => issue.source === 'resource')).toBe(true)

    // Protocol-relative is external too.
    expect(staticCheckHtml(page('', '<script src="//cdn.example.com/lib.js"></script>'))[0]?.source).toBe('resource')
  })

  it('flags a relative or root-path reference (offline means every scheme, not just http)', () => {
    expect(staticCheckHtml(page('', '<script src="./app.js"></script>'))[0]?.source).toBe('resource')
    const rooted = staticCheckHtml(page('<link rel="stylesheet" href="/styles.css">', ''))
    expect(rooted.some((issue) => issue.source === 'resource')).toBe(true)
  })

  it('flags a stylesheet link whose rel carries extra tokens', () => {
    const issues = staticCheckHtml(page('<link rel="alternate  StyleSheet" href="/a.css">', ''))
    expect(issues).toHaveLength(1)
    expect(issues[0]?.source).toBe('resource')
  })

  it('does not flag a non-stylesheet link, inline scripts, or data: image URIs', () => {
    const html = page(
      '<link rel="icon" href="data:image/gif;base64,AAAA"><style>.a{color:red}</style>',
      '<script>const x = 1; void x</script><img src="data:image/gif;base64,AAAA">',
    )
    expect(staticCheckHtml(html)).toEqual([])
  })

  it('skips non-JS scripts (importmap, JSON data island, template) instead of flagging them as bad JS', () => {
    const html = page(
      '',
      '<script type="importmap">{ "imports": { "x": "/x.js" } }</script>' +
        '<script type="application/json">{ "data": [1, 2, 3] }</script>' +
        '<script type="text/template"><div>{{ name }}</div></script>',
    )
    expect(staticCheckHtml(html)).toEqual([])
  })

  it('still checks explicitly JS-typed scripts, including legacy MIME types', () => {
    for (const type of ['text/javascript', 'text/ecmascript']) {
      const issues = staticCheckHtml(page('', `<script type="${type}">const x = ;</script>`))
      expect(issues).toHaveLength(1)
      expect(issues[0]?.source).toBe('js')
    }
  })

  it('aggregates issues across multiple blocks', () => {
    const issues = staticCheckHtml(page('<style>h1 color: red }</style>', '<script>function(</script>'))
    expect(issues.some((issue) => issue.source === 'js')).toBe(true)
    expect(issues.some((issue) => issue.source === 'css')).toBe(true)
  })

  it('returns no issues for a page with no inline JS or CSS', () => {
    expect(staticCheckHtml(page('<title>Hi</title>', '<p>Hello</p>'))).toEqual([])
  })
})

describe('validateArtifactHtml', () => {
  it('accepts a self-contained document', () => {
    const html = page(
      '<style>body{margin:0;font-family:system-ui}</style>',
      '<canvas id="c"></canvas><script>const c = document.getElementById("c"); c.width = 100</script>',
    )
    expect(validateArtifactHtml(html)).toEqual({ ok: true })
  })

  it('phrases syntax errors with their source and position so the model can self-correct', () => {
    const result = validateArtifactHtml(page('', '<script>const x = ;</script>'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toStartWith('Invalid JS (line 1')
  })

  it('phrases a blocked resource as an instruction to inline it', () => {
    const result = validateArtifactHtml(page('', '<script src="https://cdn.example.com/lib.js"></script>'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]).toContain('Inline it instead of loading <script src="https://cdn.example.com/lib.js">')
  })
})
