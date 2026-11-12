/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from './test'
import { installArtifactChannel } from './artifact-channel-fixture'
import { readFileSync } from 'node:fs'
import { artifactSandbox, wrapArtifactHtml as wrapWithDrivers } from '../src/artifacts/harness-protocol'

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
 * the production sandbox tokens, never `allow-same-origin`) and collect the
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
  error?: string
}

const collectHarnessMessages = (
  page: import('@playwright/test').Page,
  srcdoc: string,
  nonce: string,
  settleMs = 700,
): Promise<HarnessMessage[]> =>
  page.evaluate(
    ({ srcdoc, nonce, settleMs, sandbox }) =>
      new Promise<HarnessMessage[]>((resolve) => {
        const messages: HarnessMessage[] = []
        const iframe = document.createElement('iframe')
        iframe.setAttribute('sandbox', sandbox)
        const { bindArtifactChannel } = Reflect.get(
          window,
          'artifactChannel',
        ) as typeof import('../src/artifacts/channel')
        const channel = bindArtifactChannel({
          getFrameWindow: () => iframe.contentWindow,
          nonce,
          onMessage: (data) => messages.push(data),
        })
        iframe.srcdoc = srcdoc
        document.body.appendChild(iframe)
        // Enough time to load, run the sync path, and surface any async error.
        setTimeout(() => {
          channel.close()
          resolve(messages)
        }, settleMs)
      }),
    { srcdoc, nonce, settleMs, sandbox: artifactSandbox },
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
    ({ srcdoc, nonce, method, params, sandbox }) =>
      new Promise<HarnessMessage[]>((resolve, reject) => {
        const messages: HarnessMessage[] = []
        const iframe = document.createElement('iframe')
        iframe.setAttribute('sandbox', sandbox)
        iframe.style.cssText = 'width:400px;height:400px;border:0'
        const timer = setTimeout(() => reject(new Error('The page did not answer its request')), 2000)
        const { bindArtifactChannel } = Reflect.get(
          window,
          'artifactChannel',
        ) as typeof import('../src/artifacts/channel')
        const channel = bindArtifactChannel({
          getFrameWindow: () => iframe.contentWindow,
          nonce,
          onMessage: (data) => {
            messages.push(data)
            if (data.type === 'artifact-ready') {
              iframe.getBoundingClientRect()
              requestAnimationFrame(() => {
                channel.send({ artifactNonce: nonce, type: 'artifact-request', id: 1, method, params })
              })
            }
            if (data.type === 'artifact-reply' && data.id === 1) {
              clearTimeout(timer)
              channel.close()
              resolve(messages)
            }
          },
        })
        iframe.srcdoc = srcdoc
        document.body.appendChild(iframe)
      }),
    { srcdoc, nonce, method, params, sandbox: artifactSandbox },
  )

test.describe('artifact harness (real browser)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setContent('<!doctype html><html><body></body></html>')
    await installArtifactChannel(page)
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

  test('runs form handlers while CSP blocks outbound POSTs and the frame keeps its opaque origin', async ({ page }) => {
    const nonce = 'nonce-local-form'
    const target = 'https://artifact-submission.test/collect'
    const requests: string[] = []
    await page.route(target, (route) => {
      requests.push(route.request().method())
      return route.abort()
    })
    const messages = await requestHarness(
      page,
      wrapArtifactHtml(
        `<form id="form" method="post" action="${target}"><input name="value" value="private-input"></form>
<script>
window.__artifactHandlers['test/form'] = () => new Promise(resolve => {
  let submissions = 0;
  let opaqueOrigin = false;
  try { parent.document.body; } catch { opaqueOrigin = true; }
  const form = document.getElementById('form');
  form.addEventListener('submit', () => { submissions++; });
  document.addEventListener('securitypolicyviolation', event => {
    resolve({ directive: event.effectiveDirective, submissions, opaqueOrigin });
  }, { once: true });
  form.requestSubmit();
});
</script>`,
        nonce,
      ),
      nonce,
      'test/form',
    )
    expect(messages.find((message) => message.type === 'artifact-reply')?.result).toEqual({
      directive: 'form-action',
      submissions: 1,
      opaqueOrigin: true,
    })
    expect(requests).toEqual([])
    expect(messages.some((message) => message.type === 'artifact-error')).toBe(false)
  })

  test('answers unknown methods instead of leaving the host request pending', async ({ page }) => {
    const nonce = 'nonce-unknown'
    const messages = await requestHarness(page, wrapArtifactHtml('<p>Page</p>', nonce), nonce, 'page/unknown')
    expect(messages.find((message) => message.type === 'artifact-reply')).toMatchObject({ id: 1, result: null })
    expect(messages.some((message) => message.type === 'artifact-error')).toBe(false)
  })

  test('self-navigation revokes the channel before a replacement document can receive agent input or forge replies', async ({
    page,
  }) => {
    const nonce = 'navigation-document'
    const navigationUrl = 'https://artifact-replacement.test/page'
    const pendingImage = Promise.withResolvers<void>()
    await page.route('https://artifact-replacement.test/slow.png', async (route) => {
      await pendingImage.promise
      await route.abort()
    })
    await page.route(navigationUrl, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<script>
        const received = [];
        window.addEventListener('message', (event) => received.push(event.data));
        parent.postMessage({ type: 'replacement-ready' }, '*');
        // Even knowing the old nonce cannot replace its document-bound port.
        const duplicate = new MessageChannel();
        parent.postMessage({ type: 'artifact-connect', artifactNonce: '${nonce}' }, '*', [duplicate.port2]);
        parent.postMessage({ type: 'artifact-reply', artifactNonce: '${nonce}', id: 2, result: 'forged' }, '*');
        setTimeout(() => parent.postMessage({ type: 'replacement-result', received, loaded: document.readyState === 'complete' }, '*'), 100);
      </script><img src="https://artifact-replacement.test/slow.png">`,
      }),
    )
    const srcdoc = wrapArtifactHtml(
      `<script>
      window.__artifactHandlers['test/navigate'] = () => {
        setTimeout(() => { location.href = '${navigationUrl}' }, 0);
        return true;
      };
    </script>`,
      nonce,
    )
    try {
      const result = await page.evaluate(
        ({ srcdoc, nonce, sandbox }) =>
          new Promise<{
            received: unknown[]
            loaded: boolean
            closed: number
            refused: boolean
            forged: boolean
          }>((resolve, reject) => {
            const { bindArtifactChannel } = Reflect.get(
              window,
              'artifactChannel',
            ) as typeof import('../src/artifacts/channel')
            const frame = document.createElement('iframe')
            frame.setAttribute('sandbox', sandbox)
            let closed = 0
            let refused = false
            let forged = false
            const timer = setTimeout(() => reject(new Error('Replacement document did not report its result')), 5000)
            const channel = bindArtifactChannel({
              getFrameWindow: () => frame.contentWindow,
              nonce,
              onClose: () => {
                closed++
              },
              onMessage: (data) => {
                if (data.type === 'artifact-ready') {
                  channel.send({
                    artifactNonce: nonce,
                    type: 'artifact-request',
                    id: 1,
                    method: 'test/navigate',
                    params: {},
                  })
                }
                if (data.type === 'artifact-reply' && data.id === 2) {
                  forged = true
                }
              },
            })
            const receive = (event: MessageEvent) => {
              if (event.source !== frame.contentWindow) {
                return
              }
              if (event.data?.type === 'replacement-ready') {
                try {
                  channel.send({
                    artifactNonce: nonce,
                    type: 'artifact-request',
                    id: 2,
                    method: 'page/action',
                    params: { type: 'type', text: 'private-input' },
                  })
                } catch {
                  // The unload signal can precede this window message. Either
                  // ordering must keep the input away from the replacement.
                }
              }
              if (event.data?.type === 'replacement-result') {
                clearTimeout(timer)
                window.removeEventListener('message', receive)
                try {
                  channel.send({
                    artifactNonce: nonce,
                    type: 'artifact-request',
                    id: 3,
                    method: 'page/snapshot',
                    params: {},
                  })
                } catch {
                  refused = true
                }
                const result = { ...event.data, closed, refused, forged }
                channel.close()
                resolve(result)
              }
            }
            window.addEventListener('message', receive)
            frame.srcdoc = srcdoc
            document.body.append(frame)
          }),
        { srcdoc, nonce, sandbox: artifactSandbox },
      )
      expect(result.received).toEqual([])
      expect(result.loaded).toBe(false)
      expect(result.closed).toBe(1)
      expect(result.refused).toBe(true)
      expect(result.forged).toBe(false)
    } finally {
      pendingImage.resolve()
    }
  })

  test('queues early ready and errors until the host starts the transferred port', async ({ page }) => {
    const nonce = 'delayed-port-start'
    const srcdoc = wrapArtifactHtml('<script>throw new Error("early failure")</script>', nonce)
    const types = await page.evaluate(
      ({ srcdoc, nonce, sandbox }) =>
        new Promise<string[]>((resolve, reject) => {
          const iframe = document.createElement('iframe')
          iframe.setAttribute('sandbox', sandbox)
          const timer = setTimeout(() => reject(new Error('The queued messages were lost')), 3000)
          const receive = (event: MessageEvent) => {
            if (
              event.source !== iframe.contentWindow ||
              event.data?.artifactNonce !== nonce ||
              event.data?.type !== 'artifact-connect'
            ) {
              return
            }
            window.removeEventListener('message', receive)
            const port = event.ports[0]
            const types: string[] = []
            setTimeout(() => {
              port.onmessage = ({ data }: MessageEvent) => {
                types.push(data.type)
                if (types.includes('artifact-ready') && types.includes('artifact-error')) {
                  clearTimeout(timer)
                  port.close()
                  resolve(types)
                }
              }
            }, 100)
          }
          window.addEventListener('message', receive)
          iframe.srcdoc = srcdoc
          document.body.append(iframe)
        }),
      { srcdoc, nonce, sandbox: artifactSandbox },
    )
    expect(types).toContain('artifact-ready')
    expect(types).toContain('artifact-error')
  })

  for (const failure of ['throw new Error("handler failed")', 'return Promise.reject(new Error("handler failed"))']) {
    test(`reports handler failures only to their request: ${failure}`, async ({ page }) => {
      const nonce = 'nonce-handler-failure'
      const messages = await requestHarness(
        page,
        wrapArtifactHtml(`<script>window.__artifactHandlers['test/fail'] = function () { ${failure} }</script>`, nonce),
        nonce,
        'test/fail',
      )
      expect(messages.some((message) => message.type === 'artifact-error')).toBe(false)
      expect(messages.find((message) => message.type === 'artifact-reply')).toMatchObject({
        id: 1,
        result: null,
        error: 'handler failed',
      })
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
