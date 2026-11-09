/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { msg } from '@lingui/core/macro'
import { i18n } from '@lingui/core'
import type { TrayIcon } from '@tauri-apps/api/tray'
import type { Window } from '@tauri-apps/api/window'
import { createContext, useContext, type ReactNode } from 'react'
import { isTauri, isTauriDesktop } from './platform'

type TrayContextType = {
  tray: TrayIcon | undefined
  window: Window | undefined
}

const TrayContext = createContext<TrayContextType | undefined>(undefined)

export const TrayProvider = ({ children, tray, window }: TrayContextType & { children: ReactNode }) => {
  return <TrayContext.Provider value={{ tray, window }}>{children}</TrayContext.Provider>
}

export const useTray = () => {
  const context = useContext(TrayContext)
  if (context === undefined) {
    throw new Error('useTray must be used within a TrayProvider')
  }
  return context
}

export class TrayManager {
  private static initialization: Promise<TrayContextType> | undefined

  static async init(): Promise<TrayContextType> {
    TrayManager.initialization ??= TrayManager.initialize()
    try {
      return await TrayManager.initialization
    } catch (error) {
      TrayManager.initialization = undefined
      throw error
    }
  }

  static async initIfSupported(): Promise<TrayContextType> {
    if (!isTauri()) {
      return { tray: undefined, window: undefined }
    }
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    if (isTauriDesktop()) {
      try {
        return await TrayManager.init()
      } catch (error) {
        console.error('Failed to initialize tray:', error)
      }
    }
    return { tray: undefined, window: getCurrentWindow() }
  }

  private static async initialize(): Promise<TrayContextType> {
    // Keep desktop-only modules out of the web and mobile startup bundles.
    const [app, core, menuApi, trayApi, windowApi, process] = await Promise.all([
      import('@tauri-apps/api/app'),
      import('@tauri-apps/api/core'),
      import('@tauri-apps/api/menu'),
      import('@tauri-apps/api/tray'),
      import('@tauri-apps/api/window'),
      import('@tauri-apps/plugin-process'),
    ])
    const appWindow = windowApi.getCurrentWindow()
    const menu = await menuApi.Menu.new({
      items: [
        {
          id: 'show',
          text: i18n._(msg`Show`),
          action: async () => {
            try {
              await core.invoke('show_main_window')
            } catch (error) {
              console.error('Failed to show main window:', error)
            }
          },
        },
        {
          id: 'quit',
          text: i18n._(msg`Quit`),
          action: async () => {
            try {
              await process.exit(0)
            } catch (error) {
              console.error('Failed to quit:', error)
            }
          },
        },
      ],
    })

    try {
      const tray = await trayApi.TrayIcon.new({
        icon: (await app.defaultWindowIcon()) ?? undefined,
        // macOS uses the icon alpha mask to follow the menu bar theme.
        iconAsTemplate: true,
        tooltip: 'Thunderbolt',
        menu,
      })
      try {
        // Without a working tray, closing must keep the platform's normal behavior.
        await appWindow.onCloseRequested(async (event) => {
          event.preventDefault()
          try {
            await appWindow.hide()
            await appWindow.setSkipTaskbar(true)
            await core.invoke('toggle_dock_icon', { show: false })
          } catch (error) {
            console.error('Failed to hide main window:', error)
          }
        })
      } catch (error) {
        await tray.close()
        throw error
      }
      return { tray, window: appWindow }
    } catch (error) {
      await menu.close()
      throw error
    }
  }
}
