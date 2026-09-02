/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  artifactSelectionItemsSchema,
  artifactCsp,
  artifactRequest,
  parseHarnessMessage,
  wrapArtifactHtml,
  wrapArtifactPreviewHtml,
} from './harness'

describe('wrapArtifactHtml', () => {
  it('injects the harness at the start of an existing <head>, before agent content', () => {
    const html = '<!doctype html><html><head><title>T</title></head><body>x</body></html>'
    const wrapped = wrapArtifactHtml(html, 'nonce-1')
    expect(wrapped).toContain('"nonce-1"')
    expect(wrapped).toContain('postMessage')
    // Harness must precede the agent's own head content so it wins the listener race.
    expect(wrapped.indexOf('postMessage')).toBeLessThan(wrapped.indexOf('<title>'))
    expect(wrapped.indexOf('<head>')).toBeLessThan(wrapped.indexOf('postMessage'))
  })

  it('creates a <head> when the document has none', () => {
    const wrapped = wrapArtifactHtml('<!doctype html><html><body>x</body></html>', 'n')
    expect(wrapped).toContain('<head>')
    expect(wrapped.indexOf('postMessage')).toBeLessThan(wrapped.indexOf('<body>'))
  })

  it('does not mistake <header> for <head> (word-boundary match)', () => {
    const wrapped = wrapArtifactHtml('<!doctype html><html><body><header>hi</header></body></html>', 'n')
    expect(wrapped).toContain('<head>')
    // Harness lands in the created <head> before <body>, not spliced inside <header>.
    expect(wrapped.indexOf('postMessage')).toBeLessThan(wrapped.indexOf('<body>'))
  })

  it('injects after the doctype when there is no <html>/<head>', () => {
    const wrapped = wrapArtifactHtml('<!doctype html><p>hi</p>', 'n')
    expect(wrapped.toLowerCase().indexOf('<!doctype')).toBe(0)
    expect(wrapped.indexOf('postMessage')).toBeLessThan(wrapped.indexOf('<p>'))
  })

  it('prepends the harness for a bare fragment', () => {
    const wrapped = wrapArtifactHtml('<div>hi</div>', 'n')
    expect(wrapped.indexOf('postMessage')).toBeLessThan(wrapped.indexOf('<div>'))
  })

  it('injects the offline CSP meta tag into every artifact', () => {
    expect(artifactCsp).toContain("default-src 'none'")
    const wrapped = wrapArtifactHtml('<div>hi</div>', 'n')
    expect(wrapped).toContain('http-equiv="Content-Security-Policy"')
    expect(wrapped).toContain(artifactCsp)
  })

  it('injects the CSP but NOT the harness for the scripts-off streaming preview', () => {
    const wrapped = wrapArtifactPreviewHtml('<!doctype html><html><head></head><body>x</body></html>')
    expect(wrapped).toContain('http-equiv="Content-Security-Policy"')
    expect(wrapped).not.toContain('postMessage')
  })
})

describe('parseHarnessMessage', () => {
  const win = {} as Window
  const nonce = 'nonce-1'
  const ready = { artifactNonce: 'nonce-1', type: 'artifact-ready' as const }

  it('accepts a message from the matching window with the matching nonce', () => {
    expect(parseHarnessMessage({ source: win, data: ready } as MessageEvent, win, nonce)).toEqual(ready)
  })

  it('rejects a message from a different window (spoofing guard)', () => {
    expect(parseHarnessMessage({ source: {} as Window, data: ready } as MessageEvent, win, nonce)).toBeNull()
  })

  it('rejects a message with a mismatched nonce', () => {
    const other = { artifactNonce: 'other', type: 'artifact-ready' as const }
    expect(parseHarnessMessage({ source: win, data: other } as MessageEvent, win, nonce)).toBeNull()
  })

  it('rejects a non-harness message', () => {
    expect(parseHarnessMessage({ source: win, data: undefined } as MessageEvent, win, nonce)).toBeNull()
  })

  /*
   * The caps inside the injected script are advisory: the page owns its own
   * document and knows its own nonce, so it can overwrite the harness handlers
   * or post whatever it likes. Anything the host trusts is enforced here.
   *
   * Enforced by clamping rather than rejection, though. These are prompt and
   * memory budgets, not correctness constraints, and dropping the message threw
   * away a whole context update — leaving `get_app_context` to report the page
   * as silent — over one long string.
   */
  it('clamps a context summary past the cap instead of dropping the update', () => {
    const oversized = {
      artifactNonce: nonce,
      type: 'artifact-context' as const,
      context: { title: 'Q3', summary: 'x'.repeat(20_001) },
    }

    const parsed = parseHarnessMessage({ source: win, data: oversized } as MessageEvent, win, nonce)

    expect(parsed?.type).toBe('artifact-context')
    expect(parsed?.type === 'artifact-context' && parsed.context.summary).toHaveLength(20_000)
  })

  /*
   * A marquee over a wide table is exactly where this bites: one row past the
   * per-item cap failed the whole array, so the selection resolved to nothing on
   * the content-dense artifacts the gesture exists for.
   */
  it('clamps an over-long selection item rather than losing the whole result', () => {
    const parsed = artifactSelectionItemsSchema.safeParse({
      items: [{ id: 'r1', label: 'Row 1', text: 'x'.repeat(6_000) }],
    })

    expect(parsed.success && parsed.data.items[0].text).toHaveLength(5_000)
  })

  it('keeps the first 50 items when a harness sends more', () => {
    const items = Array.from({ length: 60 }, (_, i) => ({ id: `r${i}`, label: `Row ${i}`, text: 'cell' }))
    const parsed = artifactSelectionItemsSchema.safeParse({ items })

    expect(parsed.success && parsed.data.items).toHaveLength(50)
  })

  it('rejects a selection rect with a non-finite coordinate', () => {
    const hostile = {
      artifactNonce: nonce,
      type: 'artifact-selection' as const,
      selection: { text: 'hi', rect: { x: Number.POSITIVE_INFINITY, y: 0, width: 10, height: 10 } },
    }

    expect(parseHarnessMessage({ source: win, data: hostile } as MessageEvent, win, nonce)).toBeNull()
  })

  it('rejects an unknown message type rather than passing it through', () => {
    const unknown = { artifactNonce: nonce, type: 'artifact-something-else' }

    expect(parseHarnessMessage({ source: win, data: unknown } as MessageEvent, win, nonce)).toBeNull()
  })

  it('still accepts a well-formed selection', () => {
    const selection = {
      artifactNonce: nonce,
      type: 'artifact-selection' as const,
      selection: { text: 'Revenue 4.2M', rect: { x: 1, y: 2, width: 3, height: 4 } },
    }

    expect(parseHarnessMessage({ source: win, data: selection } as MessageEvent, win, nonce)).toEqual(selection)
  })
})

/**
 * Correlation, timeouts and always-settling now live in the shared request
 * registry and are tested there — what stays here is the envelope this surface
 * puts on the wire.
 */
describe('artifactRequest', () => {
  it('stamps the render nonce so another render cannot answer', () => {
    expect(artifactRequest('nonce-1', 7, 'selection/query', { rect: 1 })).toEqual({
      artifactNonce: 'nonce-1',
      type: 'artifact-request',
      id: 7,
      method: 'selection/query',
      params: { rect: 1 },
    })
  })
})
