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
  expect(button.textContent).toBe('Copy command')
  expect(container.querySelector('[role="status"]')!.textContent).toBe('')
  await act(async () => button.click())
  expect(writeText).toHaveBeenCalledWith(container.querySelector('code')!.textContent)
  expect(button.textContent).toBe('Copied')
  expect(container.querySelector('[role="status"]')!.textContent).toBe('Ready to paste into your terminal.')
})

test('denied clipboard access offers manual copying and a later successful retry clears the failure', async () => {
  writeText.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'))
  const button = container.querySelector('button')!
  await act(async () => button.click())
  expect(button.textContent).toBe('Copy command')
  expect(container.querySelector('[role="status"]')!.textContent).toBe('Select and copy the command above.')
  expect(container.querySelector('code')!.textContent).toBeTruthy()
  await act(async () => button.click())
  expect(button.textContent).toBe('Copied')
  expect(container.querySelector('[role="status"]')!.textContent).toBe('Ready to paste into your terminal.')
})

test('browsers without the Clipboard API still expose a usable manual installer', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
  await act(async () => container.querySelector('button')!.click())
  expect(container.querySelector('[role="status"]')!.textContent).toBe('Select and copy the command above.')
  expect(container.querySelector('code')!.textContent).toBeTruthy()
  expect(writeText).not.toHaveBeenCalled()
})
