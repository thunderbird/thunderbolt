/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, expect, it, mock } from 'bun:test'
import { LineChart } from 'lucide-react'
import { useMiniAppStore } from './mini-app-store'
import type { MiniAppDefinition } from './registry'

const app: MiniAppDefinition = {
  id: 'finance',
  name: 'Finance',
  description: '',
  icon: LineChart,
  url: 'https://finance.example',
  origin: 'https://finance.example',
}

afterEach(() => useMiniAppStore.getState().closeApp())

it('keeps a captured action valid after the same document republishes its tools', async () => {
  const store = useMiniAppStore.getState()
  store.openApp(app)
  const invoke = mock(async () => ({ content: 'done' }))
  store.setTools([{ name: 'save', description: 'Save' }], invoke)
  const captured = useMiniAppStore.getState().invokeTool!
  store.setTools(
    [
      { name: 'save', description: 'Save' },
      { name: 'read', description: 'Read' },
    ],
    invoke,
  )
  expect(await captured('save', { value: 1 })).toEqual({ content: 'done' })
  expect(invoke).toHaveBeenCalledWith('save', { value: 1 })
})

it.each(['reset', 'close', 'open'] as const)(
  'invalidates a captured action on document lifecycle %s',
  async (event) => {
    const store = useMiniAppStore.getState()
    store.openApp(app)
    const invoke = mock(async () => ({ content: 'done' }))
    store.setTools([{ name: 'save', description: 'Save' }], invoke)
    const captured = useMiniAppStore.getState().invokeTool!
    if (event === 'reset') {
      store.resetGuest()
    } else if (event === 'close') {
      store.closeApp()
    } else {
      store.openApp({ ...app, id: 'replacement' })
    }
    const replacement = mock(async () => ({ content: 'replacement' }))
    store.setTools([{ name: 'save', description: 'Save' }], replacement)
    expect(await captured('save', {})).toMatchObject({ isError: true })
    expect(invoke).not.toHaveBeenCalled()
    expect(replacement).not.toHaveBeenCalled()
  },
)
