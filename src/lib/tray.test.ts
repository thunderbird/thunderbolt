/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as app from '@tauri-apps/api/app'
import * as core from '@tauri-apps/api/core'
import { Menu, type MenuItemOptions } from '@tauri-apps/api/menu'
import { TrayIcon } from '@tauri-apps/api/tray'
import * as windowApi from '@tauri-apps/api/window'
import * as process from '@tauri-apps/plugin-process'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import * as platform from './platform'
import { TrayManager } from './tray'

/** Mock only the native window methods exercised by the tray lifecycle. */
const createWindow = () => ({
  hide: mock(async () => {}),
  setSkipTaskbar: mock(async (_skip: boolean) => {}),
  onCloseRequested: mock(async (_handler: Parameters<windowApi.Window['onCloseRequested']>[0]) => () => {}),
})

const appWindow = createWindow()
const nativeWindow = appWindow as unknown as windowApi.Window
const menu = { close: mock(async () => {}) } as unknown as Menu
const tray = { close: mock(async () => {}) } as unknown as TrayIcon

/** Restore a fresh singleton for each lifecycle test. */
const resetInitialization = () => Reflect.set(TrayManager, 'initialization', undefined)

beforeEach(() => {
  resetInitialization()
  appWindow.hide.mockClear()
  appWindow.setSkipTaskbar.mockClear()
  appWindow.onCloseRequested.mockClear()
  // Bun can reuse an export's existing mock, including calls from another test file.
  spyOn(platform, 'isTauri').mockReturnValue(true).mockClear()
  spyOn(platform, 'isTauriDesktop').mockReturnValue(true).mockClear()
  spyOn(windowApi, 'getCurrentWindow').mockReturnValue(nativeWindow).mockClear()
  spyOn(app, 'defaultWindowIcon').mockResolvedValue(null).mockClear()
  spyOn(core, 'invoke').mockResolvedValue(undefined).mockClear()
  spyOn(process, 'exit').mockResolvedValue(undefined).mockClear()
  spyOn(Menu, 'new').mockResolvedValue(menu).mockClear()
  spyOn(TrayIcon, 'new').mockResolvedValue(tray).mockClear()
  spyOn(menu, 'close').mockResolvedValue(undefined).mockClear()
  spyOn(tray, 'close').mockResolvedValue(undefined).mockClear()
  spyOn(console, 'error')
    .mockImplementation(() => {})
    .mockClear()
})

afterEach(() => {
  resetInitialization()
  mock.restore()
})

/** Trigger a menu callback exactly as the native menu event would. */
const clickMenuItem = async (id: string) => {
  const createMenu = spyOn(Menu, 'new')
  const items = createMenu.mock.calls[0][0]?.items as MenuItemOptions[]
  const item = items.find((entry) => entry.id === id)!
  await item.action!(id)
}

/** Request a close with an inspectable preventDefault call. */
const requestClose = async () => {
  const event = { preventDefault: mock() } as unknown as windowApi.CloseRequestedEvent
  await appWindow.onCloseRequested.mock.calls[0][0](event)
  return event
}

describe('TrayManager initialization', () => {
  it('returns no native resources on web', async () => {
    spyOn(platform, 'isTauri').mockReturnValue(false)
    expect(await TrayManager.initIfSupported()).toEqual({ tray: undefined, window: undefined })
    expect(windowApi.getCurrentWindow).not.toHaveBeenCalled()
    expect(Menu.new).not.toHaveBeenCalled()
  })

  it('returns the mobile window without creating a tray or intercepting close', async () => {
    spyOn(platform, 'isTauriDesktop').mockReturnValue(false)
    expect(await TrayManager.initIfSupported()).toEqual({ tray: undefined, window: nativeWindow })
    expect(Menu.new).not.toHaveBeenCalled()
    expect(appWindow.onCloseRequested).not.toHaveBeenCalled()
  })

  it('waits for one initialization across concurrent and later callers', async () => {
    const pendingTray = Promise.withResolvers<TrayIcon>()
    spyOn(TrayIcon, 'new').mockReturnValue(pendingTray.promise)
    const first = TrayManager.init()
    const second = TrayManager.init()
    pendingTray.resolve(tray)

    expect(await first).toEqual({ tray, window: nativeWindow })
    expect(await second).toBe(await first)
    expect(await TrayManager.init()).toBe(await first)
    expect(TrayIcon.new).toHaveBeenCalledTimes(1)
    expect(appWindow.onCloseRequested).toHaveBeenCalledTimes(1)
  })

  it('keeps the normal close behavior if tray creation fails, and allows retry', async () => {
    const error = new Error('Tray unavailable')
    spyOn(TrayIcon, 'new').mockRejectedValueOnce(error)
    expect(await TrayManager.initIfSupported()).toEqual({ tray: undefined, window: nativeWindow })
    expect(appWindow.onCloseRequested).not.toHaveBeenCalled()
    expect(menu.close).toHaveBeenCalledTimes(1)
    expect(console.error).toHaveBeenCalledWith('Failed to initialize tray:', error)

    expect(await TrayManager.initIfSupported()).toEqual({ tray, window: nativeWindow })
    expect(appWindow.onCloseRequested).toHaveBeenCalledTimes(1)
  })

  it('recovers from menu creation failure without creating a tray', async () => {
    spyOn(Menu, 'new').mockRejectedValueOnce(new Error('Menu unavailable'))
    expect(await TrayManager.initIfSupported()).toEqual({ tray: undefined, window: nativeWindow })
    expect(TrayIcon.new).not.toHaveBeenCalled()
    expect(appWindow.onCloseRequested).not.toHaveBeenCalled()
    expect(await TrayManager.initIfSupported()).toEqual({ tray, window: nativeWindow })
  })

  it('releases native resources when close-listener registration fails', async () => {
    appWindow.onCloseRequested.mockRejectedValueOnce(new Error('Listener unavailable'))
    expect(await TrayManager.initIfSupported()).toEqual({ tray: undefined, window: nativeWindow })
    expect(tray.close).toHaveBeenCalledTimes(1)
    expect(menu.close).toHaveBeenCalledTimes(1)
    expect(await TrayManager.initIfSupported()).toEqual({ tray, window: nativeWindow })
  })
})

describe('tray events', () => {
  it('restores the app through the same native command as Dock and second-launch events', async () => {
    await TrayManager.init()
    await clickMenuItem('show')
    expect(core.invoke).toHaveBeenCalledWith('show_main_window')
  })

  it('reports restore failures instead of rejecting a native event callback', async () => {
    await TrayManager.init()
    const error = new Error('Window unavailable')
    spyOn(core, 'invoke').mockRejectedValueOnce(error)
    await clickMenuItem('show')
    expect(console.error).toHaveBeenCalledWith('Failed to show main window:', error)
  })

  it('quits the application through the process plugin', async () => {
    await TrayManager.init()
    await clickMenuItem('quit')
    expect(process.exit).toHaveBeenCalledWith(0)
  })

  it('reports quit failures', async () => {
    await TrayManager.init()
    const error = new Error('Exit unavailable')
    spyOn(process, 'exit').mockRejectedValueOnce(error)
    await clickMenuItem('quit')
    expect(console.error).toHaveBeenCalledWith('Failed to quit:', error)
  })

  it('hides the window and its taskbar/Dock icon after intercepting close', async () => {
    await TrayManager.init()
    const event = await requestClose()
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(appWindow.hide).toHaveBeenCalledTimes(1)
    expect(appWindow.setSkipTaskbar).toHaveBeenCalledWith(true)
    expect(core.invoke).toHaveBeenCalledWith('toggle_dock_icon', { show: false })
  })

  it('leaves taskbar/Dock icons in place when hiding the window fails', async () => {
    await TrayManager.init()
    const error = new Error('Hide unavailable')
    appWindow.hide.mockRejectedValueOnce(error)
    await requestClose()
    expect(appWindow.setSkipTaskbar).not.toHaveBeenCalled()
    expect(core.invoke).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalledWith('Failed to hide main window:', error)
  })

  it('reports taskbar failures without hiding the Dock icon', async () => {
    await TrayManager.init()
    const error = new Error('Taskbar unavailable')
    appWindow.setSkipTaskbar.mockRejectedValueOnce(error)
    await requestClose()
    expect(core.invoke).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalledWith('Failed to hide main window:', error)
  })

  it('reports Dock command failures and keeps the tray available to restore the window', async () => {
    await TrayManager.init()
    const error = new Error('Dock unavailable')
    spyOn(core, 'invoke').mockRejectedValueOnce(error)
    await requestClose()
    expect(console.error).toHaveBeenCalledWith('Failed to hide main window:', error)
    await clickMenuItem('show')
    expect(core.invoke).toHaveBeenLastCalledWith('show_main_window')
  })
})
