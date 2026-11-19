/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SparkInstall } from './spark-install'

let container: HTMLDivElement
let root: Root
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const writeText = mock(async (_text: string) => {})

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root.render(<SparkInstall />))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
})

test('copies exactly the visible installer and announces success only when it succeeds', async () => {
  const button = container.querySelector('button')!
  expect(button.getAttribute('aria-label')).toBe('Copy command')
  expect(container.querySelector('[role="status"]')!.textContent).toBe('')
  await act(async () => button.click())
  expect(writeText).toHaveBeenCalledWith(container.querySelector('code')!.textContent)
  expect(button.getAttribute('aria-label')).toBe('Copied')
  expect(container.querySelector('[role="status"]')!.textContent).toBe(
    'Copied. Paste it into your terminal to install.',
  )
})

test('denied clipboard access offers manual copying and a later successful retry clears the failure', async () => {
  writeText.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'))
  const button = container.querySelector('button')!
  await act(async () => button.click())
  expect(button.getAttribute('aria-label')).toBe('Copy command')
  expect(container.querySelector('[role="status"]')!.textContent).toBe(
    'Couldn’t copy. Select the command and copy it manually.',
  )
  expect(container.querySelector('code')!.textContent).toBeTruthy()
  await act(async () => button.click())
  expect(button.getAttribute('aria-label')).toBe('Copied')
  expect(container.querySelector('[role="status"]')!.textContent).toBe(
    'Copied. Paste it into your terminal to install.',
  )
})

test('browsers without the Clipboard API still expose a usable manual installer', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
  await act(async () => container.querySelector('button')!.click())
  expect(container.querySelector('[role="status"]')!.textContent).toBe(
    'Couldn’t copy. Select the command and copy it manually.',
  )
  expect(container.querySelector('code')!.textContent).toBeTruthy()
  expect(writeText).not.toHaveBeenCalled()
})

test('platform choices expose supported installers and an honest Windows source-build path', async () => {
  const select = (value: string) =>
    act(() => container.querySelector<HTMLInputElement>(`input[value="${value}"]`)!.click())
  expect(container.textContent).toContain('Apple Silicon')
  await act(async () => container.querySelector('button')!.click())
  select('linux')
  expect(container.querySelector<HTMLInputElement>('input[value="linux"]')!.checked).toBe(true)
  expect(container.textContent).toContain('Linux x64 & ARM64')
  expect(container.querySelector('[role="status"]')!.textContent).toBe('')
  expect(container.querySelector('code')).not.toBeNull()
  select('windows')
  expect(container.textContent).toContain('A Windows installer isn’t available yet.')
  expect(container.querySelector('code')).toBeNull()
  expect(container.querySelector('button')).toBeNull()
  expect(container.querySelector('.spark-cli-source a')!.getAttribute('href')).toEndWith('#from-source')
  select('macos')
  expect(container.textContent).toContain('Apple Silicon')
  expect(container.querySelector('code')).not.toBeNull()
})

test('clipboard results from a previous platform do not appear on the new selection', async () => {
  const pendingCopy = Promise.withResolvers<void>()
  writeText.mockImplementationOnce(() => pendingCopy.promise)
  act(() => container.querySelector('button')!.click())
  act(() => container.querySelector<HTMLInputElement>('input[value="windows"]')!.click())
  await act(async () => pendingCopy.resolve())
  expect(container.querySelector('[role="status"]')!.textContent).toBe('')
  expect(container.querySelector('button')).toBeNull()
})
