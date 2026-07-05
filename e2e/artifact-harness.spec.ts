/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from '@playwright/test'
import { wrapArtifactHtml } from '../src/artifacts/harness'

/**
 * Real-browser coverage for the artifact harness — the runtime path happy-dom
 * cannot exercise: actual script execution inside a sandboxed iframe, the
 * ready/error/height postMessage protocol, and the offline CSP truly enforcing
 * in-engine. We drive exactly what the app renders (`wrapArtifactHtml` output in
 * a `sandbox="allow-scripts"` iframe, never `allow-same-origin`) and collect the
 * harness messages the parent would receive.
 */
type HarnessMessage = { artifactNonce: string; type: string; height?: number; reason?: string; detail?: string }

const collectHarnessMessages = (
  page: import('@playwright/test').Page,
  srcdoc: string,
  nonce: string,
  settleMs = 700,
): Promise<HarnessMessage[]> =>
  page.evaluate(
    ({ srcdoc, nonce, settleMs }) =>
      new Promise<HarnessMessage[]>((resolve) => {
        const messages: HarnessMessage[] = []
        const iframe = document.createElement('iframe')
        iframe.setAttribute('sandbox', 'allow-scripts') // must never include allow-same-origin
        window.addEventListener('message', (event) => {
          const data = event.data as HarnessMessage | undefined
          if (event.source === iframe.contentWindow && data && data.artifactNonce === nonce) {
            messages.push(data)
          }
        })
        iframe.srcdoc = srcdoc
        document.body.appendChild(iframe)
        // Enough time to load, run the sync path, and surface any async error.
        setTimeout(() => resolve(messages), settleMs)
      }),
    { srcdoc, nonce, settleMs },
  )

test.describe('artifact harness (real browser)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setContent('<!doctype html><html><body></body></html>')
  })

  test('a valid page reports ready and a content height, with no error', async ({ page }) => {
    const nonce = 'nonce-valid'
    const messages = await collectHarnessMessages(
      page,
      wrapArtifactHtml('<div style="height:180px">ok</div>', nonce),
      nonce,
    )
    const types = messages.map((m) => m.type)
    expect(types).toContain('artifact-ready')
    expect(types).not.toContain('artifact-error')
    const height = messages.find((m) => m.type === 'artifact-height')
    expect(height?.height ?? 0).toBeGreaterThan(0)
  })

  test('an uncaught exception is reported as an error', async ({ page }) => {
    const nonce = 'nonce-throw'
    const messages = await collectHarnessMessages(
      page,
      wrapArtifactHtml('<script>throw new Error("boom-xyz")</script>', nonce),
      nonce,
    )
    const error = messages.find((m) => m.type === 'artifact-error')
    expect(error?.reason).toBe('exception')
    expect(error?.detail ?? '').toContain('boom-xyz')
  })

  test('an unhandled promise rejection is reported as an error', async ({ page }) => {
    const nonce = 'nonce-reject'
    const messages = await collectHarnessMessages(
      page,
      wrapArtifactHtml('<script>Promise.reject(new Error("nope-abc"))</script>', nonce),
      nonce,
    )
    const error = messages.find((m) => m.type === 'artifact-error')
    expect(error?.reason).toBe('unhandled-rejection')
    expect(error?.detail ?? '').toContain('nope-abc')
  })

  test('a blocked/failed subresource does not fail the page (still ready, no error)', async ({ page }) => {
    const nonce = 'nonce-img'
    const messages = await collectHarnessMessages(
      page,
      // The external image is blocked by img-src (data:/blob: only); a failed subresource must not fail the page.
      wrapArtifactHtml('<img src="https://example.com/nope.png"><div>ok</div>', nonce),
      nonce,
    )
    const types = messages.map((m) => m.type)
    expect(types).toContain('artifact-ready')
    expect(types).not.toContain('artifact-error')
  })
})
