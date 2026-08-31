/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getClock } from '@/testing-library'
import { describe, expect, it } from 'bun:test'
import {
  artifactCsp,
  parseHarnessMessage,
  requestFromArtifact,
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
})

/**
 * The host half of the new two-way channel. A real iframe isn't available here,
 * so the guest is stubbed: `postMessage` on the fake window is what the harness
 * script would call, and replies are dispatched back through a real `message`
 * event so the listener under test does the same nonce and source matching it
 * would in a browser.
 */
describe('requestFromArtifact', () => {
  const nonce = 'nonce-1'

  /** A stand-in guest that answers with `reply(params)`, or never answers when null. */
  const fakeFrame = (reply: ((params: unknown) => unknown) | null) => {
    const sent: { method: string; params: unknown }[] = []
    const frame = {
      postMessage: (message: unknown) => {
        const request = message as { id: number; method: string; params: unknown; type: string }
        sent.push({ method: request.method, params: request.params })
        if (!reply) {
          return
        }
        window.dispatchEvent(
          new MessageEvent('message', {
            source: frame as unknown as Window,
            data: { artifactNonce: nonce, type: 'artifact-reply', id: request.id, result: reply(request.params) },
          }),
        )
      },
    }
    return { frame: frame as unknown as Window, sent }
  }

  it('sends the method and params, and resolves with the reply', async () => {
    const { frame, sent } = fakeFrame((params) => ({ echoed: params }))

    const result = await requestFromArtifact(frame, nonce, 'selection/query', { rect: 1 }, 1_000)

    expect(sent).toEqual([{ method: 'selection/query', params: { rect: 1 } }])
    expect(result).toEqual({ echoed: { rect: 1 } })
  })

  it('resolves null when the page never answers, rather than hanging', async () => {
    const { frame } = fakeFrame(null)
    // The suite runs on a fake clock, so the timeout has to be advanced by hand.
    const pending = requestFromArtifact(frame, nonce, 'anything', {}, 10)
    await getClock().runAllAsync()
    expect(await pending).toBeNull()
  })

  it('resolves null with no frame at all', async () => {
    expect(await requestFromArtifact(null, nonce, 'anything', {}, 10)).toBeNull()
  })

  /** Two renders of the same artifact must not read each other's replies. */
  it("ignores a reply carrying another render's nonce", async () => {
    const { frame } = fakeFrame(() => 'wrong-render')
    window.dispatchEvent(
      new MessageEvent('message', {
        source: frame,
        data: { artifactNonce: 'someone-else', type: 'artifact-reply', id: 1, result: 'leaked' },
      }),
    )
    const pending = requestFromArtifact(frame, 'a-different-nonce', 'x', {}, 10)
    await getClock().runAllAsync()
    expect(await pending).toBeNull()
  })

  it('pairs concurrent requests with their own replies', async () => {
    const { frame } = fakeFrame((params) => params)

    const [first, second] = await Promise.all([
      requestFromArtifact(frame, nonce, 'a', 'first', 1_000),
      requestFromArtifact(frame, nonce, 'b', 'second', 1_000),
    ])

    expect(first).toBe('first')
    expect(second).toBe('second')
  })
})
