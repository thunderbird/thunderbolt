/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { setAndroidBarColor } from './set-android-bar-color'

describe('setAndroidBarColor', () => {
  it('calls invoke with plugin command and style "dark" when Tauri', async () => {
    let invokedWith: { command: string; args: Record<string, string> } | null = null

    await setAndroidBarColor('dark', {
      isTauri: () => true,
      invoke: (cmd, args) => {
        invokedWith = { command: cmd, args: args as Record<string, string> }
        return Promise.resolve()
      },
    })

    expect(invokedWith!).toEqual({ command: 'plugin:platform-utils|set_bar_color', args: { style: 'dark' } })
  })

  it('calls invoke with plugin command and style "light" when Tauri', async () => {
    let invokedWith: { command: string; args: Record<string, string> } | null = null

    await setAndroidBarColor('light', {
      isTauri: () => true,
      invoke: (cmd, args) => {
        invokedWith = { command: cmd, args: args as Record<string, string> }
        return Promise.resolve()
      },
    })

    expect(invokedWith!).toEqual({ command: 'plugin:platform-utils|set_bar_color', args: { style: 'light' } })
  })

  it('does not call invoke when not running in Tauri', async () => {
    let invokeCalled = false

    await setAndroidBarColor('dark', {
      isTauri: () => false,
      invoke: () => {
        invokeCalled = true
        return Promise.resolve()
      },
    })

    expect(invokeCalled).toBe(false)
  })

  it('propagates invoke errors (no silent catch)', async () => {
    const error = new Error('command failed')

    const promise = setAndroidBarColor('dark', {
      isTauri: () => true,
      invoke: () => Promise.reject(error),
    })

    await expect(promise).rejects.toThrow('command failed')
  })
})
