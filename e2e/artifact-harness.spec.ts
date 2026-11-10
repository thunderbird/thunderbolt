/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from './test'
import { readFileSync } from 'node:fs'
import { wrapArtifactHtml as wrapWithDrivers } from '../src/artifacts/harness-protocol'

// Use the exact same fixed driver bytes that Vite supplies through ?raw in the app.
const driverSource = [
  new URL('../src/browser/page-driver.js', import.meta.url),
  new URL('../src/pages/iframe-page-driver.js', import.meta.url),
]
  .map((url) => readFileSync(url, 'utf8'))
  .join('\n')
const wrapArtifactHtml = (html: string, nonce: string) => wrapWithDrivers(html, nonce, driverSource)

/**
 * Real-browser coverage for the artifact harness — the runtime path happy-dom
 * cannot exercise: actual script execution inside a sandboxed iframe, the
 * ready/error/height postMessage protocol, and the offline CSP truly enforcing
 * in-engine. We drive exactly what the app renders (`wrapArtifactHtml` output in
 * a `sandbox="allow-scripts"` iframe, never `allow-same-origin`) and collect the
 * harness messages the parent would receive.
 */
type HarnessMessage = {
  artifactNonce: string
  type: string
  height?: number
  reason?: string
  detail?: string
  id?: number
  result?: unknown
}

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

/** Exercise the same generic request bridge used by native and sandboxed page tools. */
const requestHarness = (
  page: import('@playwright/test').Page,
  srcdoc: string,
  nonce: string,
  method: string,
  params: unknown = {},
): Promise<HarnessMessage[]> =>
  page.evaluate(
    ({ srcdoc, nonce, method, params }) =>
      new Promise<HarnessMessage[]>((resolve, reject) => {
        const messages: HarnessMessage[] = []
        const iframe = document.createElement('iframe')
        iframe.setAttribute('sandbox', 'allow-scripts')
        iframe.style.cssText = 'width:400px;height:400px;border:0'
        const timer = setTimeout(() => reject(new Error('The page did not answer its request')), 2000)
        window.addEventListener('message', (event) => {
          const data = event.data as HarnessMessage | undefined
          if (event.source !== iframe.contentWindow || data?.artifactNonce !== nonce) {
            return
          }
          messages.push(data)
          if (data.type === 'artifact-ready') {
            iframe.getBoundingClientRect()
            // Opaque sandbox origins require '*'; replies are scoped to this frame and nonce.
            // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration.wildcard-postmessage-configuration -- opaque sandbox origin
            iframe.contentWindow?.postMessage(
              { artifactNonce: nonce, type: 'artifact-request', id: 1, method, params },
              '*',
            )
          }
          if (data.type === 'artifact-reply' && data.id === 1) {
            clearTimeout(timer)
            resolve(messages)
          }
        })
        iframe.srcdoc = srcdoc
        document.body.appendChild(iframe)
      }),
    { srcdoc, nonce, method, params },
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
    // Chrome can report zero before the first layout; the host consumes the latest height.
    const height = messages.findLast((m) => m.type === 'artifact-height')
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
    expect(error?.detail?.trim()).toBeTruthy()
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
    expect(error?.detail ?? '').toMatch(/:\d+:\d+/)
    expect(error?.detail?.match(/nope-abc/g)).toHaveLength(1)
  })

  test('a rejection keeps its message when the stack has only a location', async ({ page }) => {
    const nonce = 'nonce-reject-location'
    const messages = await collectHarnessMessages(
      page,
      wrapArtifactHtml(
        '<script>Promise.reject({ message: "nope-webkit", stack: "at artifact.js:12:34" })</script>',
        nonce,
      ),
      nonce,
    )
    const error = messages.find((m) => m.type === 'artifact-error')
    expect(error?.reason).toBe('unhandled-rejection')
    expect(error?.detail).toContain('nope-webkit')
    expect(error?.detail).toContain('artifact.js:12:34')
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

  test('routes page snapshots through the correlated generic request bridge', async ({ page }) => {
    const nonce = 'nonce-snapshot'
    const messages = await requestHarness(
      page,
      wrapArtifactHtml('<h1>Shopping list</h1><button>Add milk</button>', nonce),
      nonce,
      'page/snapshot',
    )
    expect(messages.find((message) => message.type === 'artifact-reply')?.result).toMatchObject({
      text: expect.stringContaining('Shopping list'),
      elements: expect.arrayContaining([expect.objectContaining({ role: 'button', name: 'Add milk' })]),
    })
    expect(messages.some((message) => message.type === 'artifact-error')).toBe(false)
  })

  test('answers unknown methods instead of leaving the host request pending', async ({ page }) => {
    const nonce = 'nonce-unknown'
    const messages = await requestHarness(page, wrapArtifactHtml('<p>Page</p>', nonce), nonce, 'page/unknown')
    expect(messages.find((message) => message.type === 'artifact-reply')).toMatchObject({ id: 1, result: null })
    expect(messages.some((message) => message.type === 'artifact-error')).toBe(false)
  })

  for (const failure of ['throw new Error("handler failed")', 'return Promise.reject(new Error("handler failed"))']) {
    test(`reports handler failures and settles its request: ${failure}`, async ({ page }) => {
      const nonce = 'nonce-handler-failure'
      const messages = await requestHarness(
        page,
        wrapArtifactHtml(`<script>window.__artifactHandlers['test/fail'] = function () { ${failure} }</script>`, nonce),
        nonce,
        'test/fail',
      )
      expect(messages.find((message) => message.type === 'artifact-error')).toMatchObject({
        reason: 'handler',
        detail: 'handler failed',
      })
      expect(messages.find((message) => message.type === 'artifact-reply')).toMatchObject({ id: 1, result: null })
    })
  }

  test('updates content height when the page grows and shrinks without publishing unused DOM context', async ({
    page,
  }) => {
    const nonce = 'nonce-resize'
    const html = `<!doctype html><html><head><style>body{margin:0}</style></head><body>
      <div id="content" style="height:40px">Initial content</div>
      <script>
        setTimeout(() => { document.getElementById('content').style.height = '400px' }, 100);
        setTimeout(() => { document.getElementById('content').style.height = '70px' }, 300);
      </script>
    </body></html>`
    const messages = await collectHarnessMessages(page, wrapArtifactHtml(html, nonce), nonce)
    const heights = messages.filter((message) => message.type === 'artifact-height').map((message) => message.height!)
    expect(Math.max(...heights)).toBeGreaterThanOrEqual(400)
    expect(heights.at(-1)).toBe(70)
    expect([...new Set(messages.map((message) => message.type))].sort()).toEqual(['artifact-height', 'artifact-ready'])
  })
})
