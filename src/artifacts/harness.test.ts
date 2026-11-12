/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  artifactCsp,
  artifactRequest,
  formatHarnessError,
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

describe('formatHarnessError', () => {
  it.each([
    ['exception', 'Uncaught error'],
    ['unhandled-rejection', 'Unhandled promise rejection'],
  ] as const)('labels %s', (reason, label) => {
    const line = formatHarnessError({
      artifactNonce: 'n',
      type: 'artifact-error',
      reason,
      detail: 'boom',
    })

    expect(line).toBe(`${label}: boom`)
  })
})

describe('parseHarnessMessage', () => {
  const nonce = 'nonce-1'
  const ready = { artifactNonce: 'nonce-1', type: 'artifact-ready' as const }

  it('accepts a message with the matching nonce', () => {
    expect(parseHarnessMessage(ready, nonce)).toEqual(ready)
  })

  it('rejects a message with a mismatched nonce', () => {
    const other = { artifactNonce: 'other', type: 'artifact-ready' as const }
    expect(parseHarnessMessage(other, nonce)).toBeNull()
  })

  it('rejects a non-harness message', () => {
    expect(parseHarnessMessage(undefined, nonce)).toBeNull()
  })

  it('clamps oversized diagnostics while preserving the error', () => {
    const data = { artifactNonce: nonce, type: 'artifact-error', reason: 'exception', detail: 'x'.repeat(2_001) }
    const parsed = parseHarnessMessage(data, nonce)
    expect(parsed?.type).toBe('artifact-error')
    expect(parsed?.type === 'artifact-error' && parsed.detail).toHaveLength(2_000)
  })

  it('rejects non-finite heights and non-integer reply ids', () => {
    for (const data of [
      { artifactNonce: nonce, type: 'artifact-height', height: Infinity },
      { artifactNonce: nonce, type: 'artifact-reply', id: 1.5, result: null },
    ]) {
      expect(parseHarnessMessage(data, nonce)).toBeNull()
    }
  })

  it('accepts a correlated generic reply without assuming its method-specific result shape', () => {
    const data = {
      artifactNonce: nonce,
      type: 'artifact-reply' as const,
      id: 4,
      result: { documentId: 'document', elements: [] },
    }
    expect(parseHarnessMessage(data, nonce)).toEqual(data)
  })

  it('bounds correlated request errors without turning them into page runtime errors', () => {
    const parsed = parseHarnessMessage(
      { artifactNonce: nonce, type: 'artifact-reply', id: 4, result: null, error: 'x'.repeat(2_001) },
      nonce,
    )
    expect(parsed?.type).toBe('artifact-reply')
    expect(parsed?.type === 'artifact-reply' && parsed.error).toHaveLength(2_000)
    expect(
      parseHarnessMessage(
        { artifactNonce: nonce, type: 'artifact-error', reason: 'handler', detail: 'Stale operation error' },
        nonce,
      ),
    ).toBeNull()
  })

  it('rejects an unknown message type rather than passing it through', () => {
    const unknown = { artifactNonce: nonce, type: 'artifact-something-else' }

    expect(parseHarnessMessage(unknown, nonce)).toBeNull()
  })
})

/**
 * Correlation, timeouts and always-settling now live in the shared request
 * registry and are tested there — what stays here is the envelope this surface
 * puts on the wire.
 */
describe('artifactRequest', () => {
  it('stamps the render nonce so another render cannot answer', () => {
    expect(artifactRequest('nonce-1', 7, 'page/action', { type: 'click', x: 1, y: 2 })).toEqual({
      artifactNonce: 'nonce-1',
      type: 'artifact-request',
      id: 7,
      method: 'page/action',
      params: { type: 'click', x: 1, y: 2 },
    })
  })
})
