/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from './test'
import { installArtifactChannel } from './artifact-channel-fixture'
import { artifactSandbox, wrapArtifactHtml } from '../src/artifacts/harness-protocol'
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

test('the HTML page driver supports clicks, game right-clicks, typing and synthetic keys', async ({ page }) => {
  const nonce = 'page-driver-fixture'
  const srcdoc = wrapArtifactHtml(
    `<!doctype html><html><body>
<input aria-label="Draft" id="draft"><output id="events">No input yet</output>
<button id="save">Save</button><output id="saved"></output>
<form id="entry"><input aria-label="Task" id="task"><button type="submit">Add task</button></form>
<output id="submitted">Not submitted</output><output id="form-keys">No form keys</output>
<div id="board"><button id="mine" data-mine aria-label="Mine cell" style="width:120px;height:40px">Hidden</button><div id="shadow-cell"></div></div>
<button disabled aria-label="Disabled mine cell">Disabled</button>
<output id="mine-actions">Flags: 0; Revealed: 0</output><output id="context-event"></output>
<script>
const draft = document.getElementById('draft');
draft.oninput = () => document.getElementById('events').textContent = 'Input event: ' + draft.value;
draft.onkeydown = e => document.getElementById('saved').textContent = 'Key event: ' + e.key;
document.getElementById('save').onclick = () => document.getElementById('saved').textContent = 'Saved: ' + draft.value;
document.getElementById('entry').onsubmit = e => {
  e.preventDefault();
  document.getElementById('submitted').textContent = 'Submitted: ' + document.getElementById('task').value;
};
document.getElementById('task').onkeydown = e => document.getElementById('form-keys').textContent = 'Form key: ' + e.key;
const shadowCell = document.getElementById('shadow-cell').attachShadow({mode:'open'});
shadowCell.innerHTML = '<button data-mine aria-label="Shadow mine cell">Hidden</button>';
let flagActions = 0;
let reveals = 0;
const reportActions = () => document.getElementById('mine-actions').textContent = 'Flags: ' + flagActions + '; Revealed: ' + reveals;
document.getElementById('board').onclick = () => { reveals++; reportActions(); };
document.getElementById('board').oncontextmenu = e => {
  e.preventDefault();
  const cell = e.composedPath().find(node => node instanceof Element && node.matches('[data-mine]'));
  cell.textContent = cell.textContent === 'Hidden' ? 'Flagged' : 'Hidden';
  flagActions++;
  reportActions();
  const bounds = cell.getBoundingClientRect();
  document.getElementById('context-event').textContent = JSON.stringify({
    button: e.button, buttons: e.buttons, pointerType: e.pointerType, trusted: e.isTrusted,
    cancelled: e.defaultPrevented, composed: e.composed,
    inside: e.clientX >= bounds.left && e.clientX <= bounds.right && e.clientY >= bounds.top && e.clientY <= bounds.bottom
  });
};
</script></body></html>`,
    nonce,
    driverSource,
  )
  await page.setContent('<!doctype html><html><body></body></html>')
  await installArtifactChannel(page)
  const result = await page.evaluate(
    async ({ nonce, srcdoc, sandbox }) => {
      const frame = document.createElement('iframe')
      frame.setAttribute('sandbox', sandbox)
      frame.style.cssText = 'width:600px;height:400px;border:0'
      const { bindArtifactChannel } = Reflect.get(
        window,
        'artifactChannel',
      ) as typeof import('../src/artifacts/channel')
      const handlers = new Map<
        number,
        { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
      >()
      const pageErrors: string[] = []
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
            pageErrors.push(data.detail)
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
              if (data.error !== undefined) {
                handler.reject(new Error(data.error))
              } else {
                handler.resolve(data.result)
              }
            }
          }
        },
      })
      frame.srcdoc = srcdoc
      document.body.appendChild(frame)
      await waitReady
      frame.getBoundingClientRect()
      await new Promise(requestAnimationFrame)
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

      const task = after.elements.find((element) => element.name === 'Task')!
      const submit = after.elements.find((element) => element.name === 'Add task')!
      await request('page/action', { type: 'type', ref: task.ref, text: 'Test the form' })
      await request('page/action', { type: 'key', key: 'Enter' })
      const afterEnter = (await request('page/snapshot', {})) as PageSnapshot
      const rejectedChords: string[] = []
      for (const chord of ['Control+a', 'Meta+a', 'Shift+Tab']) {
        try {
          await request('page/action', { type: 'key', key: chord })
          rejectedChords.push('Unexpected success')
        } catch (error) {
          rejectedChords.push(String(error))
        }
      }
      const afterChords = (await request('page/snapshot', {})) as PageSnapshot
      await request('page/action', { type: 'key', key: '+' })
      const afterPlus = (await request('page/snapshot', {})) as PageSnapshot
      await request('page/action', { type: 'click', ref: submit.ref })
      const afterSubmit = (await request('page/snapshot', {})) as PageSnapshot

      const mine = afterSubmit.elements.find((element) => element.name === 'Mine cell')!
      await request('page/action', { type: 'click', ref: mine.ref, button: 'right' })
      const afterFlag = (await request('page/snapshot', {})) as PageSnapshot
      await request('page/action', {
        type: 'click',
        x: mine.rect.x + mine.rect.width / 2,
        y: mine.rect.y + mine.rect.height / 2,
        button: 'right',
      })
      const afterUnflag = (await request('page/snapshot', {})) as PageSnapshot
      const shadowMine = afterUnflag.elements.find((element) => element.name === 'Shadow mine cell')!
      await request('page/action', { type: 'click', ref: shadowMine.ref, button: 'right' })
      const afterShadowFlag = (await request('page/snapshot', {})) as PageSnapshot
      const disabledMine = afterShadowFlag.elements.find((element) => element.name === 'Disabled mine cell')!
      const disabledRightClick = await (async () => {
        try {
          await request('page/action', { type: 'click', ref: disabledMine.ref, button: 'right' })
          return 'Unexpected success'
        } catch (error) {
          return String(error)
        }
      })()
      await request('page/action', { type: 'click', ref: mine.ref })
      const afterReveal = (await request('page/snapshot', {})) as PageSnapshot
      channel.close()
      return {
        click,
        type,
        key,
        saveClick,
        before,
        typed,
        keyed,
        after,
        afterEnter,
        rejectedChords,
        afterChords,
        afterPlus,
        afterSubmit,
        afterFlag,
        afterUnflag,
        afterShadowFlag,
        disabledRightClick,
        afterReveal,
        pageErrors,
      }
    },
    { nonce, srcdoc, sandbox: artifactSandbox },
  )
  expect([result.click, result.type, result.key, result.saveClick]).toEqual([true, true, true, true])
  expect(result.typed.elements.find((element) => element.name === 'Draft')?.value).toBe('hello from agent')
  expect(result.typed.text).toContain('Input event: hello from agent')
  expect(result.keyed.text).toContain('Key event: Enter')
  expect(result.after.text).toContain('Saved: hello from agent')
  expect(result.after.documentId).toBe(result.before.documentId)
  expect(result.afterEnter.text).toContain('Form key: Enter')
  expect(result.afterEnter.text).toContain('Not submitted')
  expect(result.rejectedChords).toHaveLength(3)
  for (const rejection of result.rejectedChords) {
    expect(rejection).toContain('Modifier chords require a native browser')
  }
  expect(result.afterChords.text).toContain('Form key: Enter')
  expect(result.afterChords.text).not.toContain('Control+a')
  expect(result.afterChords.elements.find((element) => element.name === 'Task')?.value).toBe('Test the form')
  expect(result.afterPlus.text).toContain('Form key: +')
  expect(result.afterSubmit.text).toContain('Submitted: Test the form')
  expect(result.afterFlag.elements.find((element) => element.name === 'Mine cell')?.text).toBe('Flagged')
  expect(result.afterFlag.text).toContain('Flags: 1; Revealed: 0')
  expect(result.afterUnflag.elements.find((element) => element.name === 'Mine cell')?.text).toBe('Hidden')
  expect(result.afterShadowFlag.elements.find((element) => element.name === 'Shadow mine cell')?.text).toBe('Flagged')
  expect(result.afterShadowFlag.text).toContain('Flags: 3; Revealed: 0')
  expect(result.afterShadowFlag.text).toContain(
    '"button":2,"buttons":2,"pointerType":"mouse","trusted":false,"cancelled":true,"composed":true,"inside":true',
  )
  expect(result.disabledRightClick).toContain('Element is disabled')
  expect(result.afterReveal.text).toContain('Flags: 3; Revealed: 1')
  expect(result.pageErrors).toEqual([])
})
