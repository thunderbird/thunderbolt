/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { i18n } from '@lingui/core'
import * as core from '@tauri-apps/api/core'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import * as platform from './platform'
import { TrayManager } from './tray'

beforeEach(() => {
  spyOn(platform, 'isTauriDesktop').mockReturnValue(true).mockClear()
  spyOn(core, 'invoke').mockResolvedValue(undefined).mockClear()
})

afterEach(() => mock.restore())

describe('TrayManager', () => {
  it('does not initialize a native tray on web or mobile', async () => {
    spyOn(platform, 'isTauriDesktop').mockReturnValue(false)
    await TrayManager.initIfSupported()
    expect(core.invoke).not.toHaveBeenCalled()
  })

  it('waits for native initialization to finish', async () => {
    const nativeReady = Promise.withResolvers<void>()
    const invoked = Promise.withResolvers<void>()
    spyOn(core, 'invoke').mockImplementationOnce(async <T>() => {
      invoked.resolve()
      await nativeReady.promise
      return undefined as T
    })
    const finished = mock()
    const initialize = async () => {
      await TrayManager.initIfSupported()
      finished()
    }
    const pending = initialize()
    await invoked.promise
    expect(finished).not.toHaveBeenCalled()
    nativeReady.resolve()
    await pending
    expect(finished).toHaveBeenCalledTimes(1)
  })

  it('passes translated labels on every initialization, including after a reload', async () => {
    const previousLocale = i18n.locale
    try {
      i18n.load('en-x-tray-test', { Show: 'Afficher', Quit: 'Quitter' })
      i18n.activate('en-x-tray-test')
      await TrayManager.initIfSupported()
      expect(core.invoke).toHaveBeenLastCalledWith('initialize_tray', {
        showLabel: 'Afficher',
        quitLabel: 'Quitter',
      })

      i18n.load('en-x-tray-test', { Show: 'Zeigen', Quit: 'Beenden' })
      await TrayManager.initIfSupported()
      expect(core.invoke).toHaveBeenLastCalledWith('initialize_tray', {
        showLabel: 'Zeigen',
        quitLabel: 'Beenden',
      })
    } finally {
      i18n.activate(previousLocale)
    }
  })

  it('delegates concurrent initialization to the native process owner', async () => {
    await Promise.all([TrayManager.initIfSupported(), TrayManager.initIfSupported()])
    expect(core.invoke).toHaveBeenCalledTimes(2)
  })

  it('propagates native failure to the app initialization boundary and permits retry', async () => {
    const error = new Error('Tray unavailable')
    spyOn(core, 'invoke').mockRejectedValueOnce(error)
    await expect(TrayManager.initIfSupported()).rejects.toBe(error)
    await TrayManager.initIfSupported()
    expect(core.invoke).toHaveBeenCalledTimes(2)
  })
})
