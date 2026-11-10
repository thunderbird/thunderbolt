/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from './test'
import { installArtifactChannel } from './artifact-channel-fixture'
import { wrapArtifactHtml } from '../src/artifacts/harness-protocol'
import type { PageSnapshot } from '../shared/page-protocol'

const driverSource = [
  new URL('../src/browser/page-driver.js', import.meta.url),
  new URL('../src/pages/iframe-page-driver.js', import.meta.url),
]
  .map((url) => readFileSync(url, 'utf8'))
  .join('\n')

test('native input preparation honors disabled fieldsets and shadow-root focus', async ({ page }) => {
  await page.setContent(`<fieldset disabled>
    <legend><input aria-label="Legend field"></legend><input aria-label="Disabled field">
  </fieldset><div id="host"></div>`)
  await page.addScriptTag({ path: fileURLToPath(new URL('../src/browser/page-driver.js', import.meta.url)) })
  const result = await page.evaluate(() => {
    const driver = Reflect.get(window, '__thunderboltBrowserDriver') as {
      snapshot: () => PageSnapshot
      prepare: (action: { type: string; ref?: string; text: string }) => unknown
    }
    const elements = driver.snapshot().elements
    const disabled = elements.find((element) => element.name === 'Disabled field')!
    const legend = elements.find((element) => element.name === 'Legend field')!
    const disabledError = (() => {
      try {
        driver.prepare({ type: 'type', ref: disabled.ref, text: 'No' })
        return null
      } catch (error) {
        return String(error)
      }
    })()
    driver.prepare({ type: 'type', ref: legend.ref, text: 'Allowed' })
    const legendFocused = document.activeElement?.getAttribute('aria-label')
    const shadow = document.getElementById('host')!.attachShadow({ mode: 'open' })
    const input = document.createElement('input')
    shadow.append(input)
    input.focus()
    driver.prepare({ type: 'type', text: 'Shadow input' })
    return { disabledError, legendFocused, shadowFocused: shadow.activeElement === input }
  })
  expect(result.disabledError).toContain('Element is disabled')
  expect(result.legendFocused).toBe('Legend field')
  expect(result.shadowFocused).toBe(true)
})

test('the HTML page driver can click, type, dispatch keys and read the updated shared snapshot', async ({ page }) => {
  const nonce = 'page-driver-fixture'
  const srcdoc = wrapArtifactHtml(
    `<!doctype html><html><body>
<input aria-label="Draft" id="draft"><output id="events">No input yet</output>
<button id="save">Save</button><output id="saved"></output>
<script>
const draft = document.getElementById('draft');
draft.oninput = () => document.getElementById('events').textContent = 'Input event: ' + draft.value;
draft.onkeydown = e => document.getElementById('saved').textContent = 'Key event: ' + e.key;
document.getElementById('save').onclick = () => document.getElementById('saved').textContent = 'Saved: ' + draft.value;
</script></body></html>`,
    nonce,
    driverSource,
  )
  await page.setContent('<!doctype html><html><body></body></html>')
  await installArtifactChannel(page)
  const result = await page.evaluate(
    async ({ nonce, srcdoc }) => {
      const frame = document.createElement('iframe')
      frame.sandbox.add('allow-scripts')
      frame.style.cssText = 'width:600px;height:400px;border:0'
      const { bindArtifactChannel } = Reflect.get(
        window,
        'artifactChannel',
      ) as typeof import('../src/artifacts/channel')
      const handlers = new Map<
        number,
        { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
      >()
      let onReady: () => void
      const waitReady = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Driver did not become ready')), 5000)
        onReady = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      const channel = bindArtifactChannel({
        getFrameWindow: () => frame.contentWindow,
        nonce,
        onMessage: (data) => {
          if (data.type === 'artifact-ready') {
            onReady()
          }
          if (data.type === 'artifact-error') {
            for (const handler of handlers.values()) {
              clearTimeout(handler.timer)
              handler.reject(new Error(data.detail))
            }
            handlers.clear()
          }
          if (data.type === 'artifact-reply') {
            const handler = handlers.get(data.id)
            if (handler) {
              clearTimeout(handler.timer)
              handlers.delete(data.id)
              handler.resolve(data.result)
            }
          }
        },
      })
      frame.srcdoc = srcdoc
      document.body.appendChild(frame)
      await waitReady
      frame.getBoundingClientRect()
      let sequence = 0
      const request = (method: string, params: unknown) =>
        new Promise<unknown>((resolve, reject) => {
          const id = ++sequence
          const timer = setTimeout(() => {
            handlers.delete(id)
            reject(new Error('Driver request timed out'))
          }, 3000)
          handlers.set(id, { resolve, reject, timer })
          channel.send({ artifactNonce: nonce, type: 'artifact-request', id, method, params })
        })
      const before = (await request('page/snapshot', {})) as PageSnapshot
      const input = before.elements.find((element) => element.name === 'Draft')
      const save = before.elements.find((element) => element.name === 'Save')
      if (!input || !save) {
        throw new Error('Fixture input and button absent')
      }
      const click = await request('page/action', { type: 'click', ref: input.ref })
      const type = await request('page/action', { type: 'type', text: 'hello from agent' })
      const typed = (await request('page/snapshot', {})) as PageSnapshot
      const key = await request('page/action', { type: 'key', key: 'Enter' })
      const keyed = (await request('page/snapshot', {})) as PageSnapshot
      const saveClick = await request('page/action', { type: 'click', ref: save.ref })
      const after = (await request('page/snapshot', {})) as PageSnapshot
      channel.close()
      return { click, type, key, saveClick, before, typed, keyed, after }
    },
    { nonce, srcdoc },
  )
  expect([result.click, result.type, result.key, result.saveClick]).toEqual([true, true, true, true])
  expect(result.typed.elements.find((element) => element.name === 'Draft')?.value).toBe('hello from agent')
  expect(result.typed.text).toContain('Input event: hello from agent')
  expect(result.keyed.text).toContain('Key event: Enter')
  expect(result.after.text).toContain('Saved: hello from agent')
  expect(result.after.documentId).toBe(result.before.documentId)
})
