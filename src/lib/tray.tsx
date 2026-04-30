/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createContext, useContext, type ReactNode } from 'react'
import { isDesktop, isTauri } from './platform'

// Lazy load Tauri modules only when needed
let tauriCore: any = null
let tauriMenu: any = null
let tauriTray: any = null
let tauriWindow: any = null
let tauriProcess: any = null

const loadTauriModules = async () => {
  if (isTauri() && !tauriCore) {
    try {
      tauriCore = await import('@tauri-apps/api/core')
      tauriMenu = await import('@tauri-apps/api/menu')
      tauriTray = await import('@tauri-apps/api/tray')
      tauriWindow = await import('@tauri-apps/api/window')
      tauriProcess = await import('@tauri-apps/plugin-process')
    } catch (error) {
      console.error('Failed to load Tauri modules:', error)
    }
  }
}

type TrayContextType = {
  tray: any | undefined // Changed from TrayIcon to any for compatibility
  window: any | undefined // Changed from Window to any for compatibility
}

const TrayContext = createContext<TrayContextType | undefined>(undefined)

export const TrayProvider = ({ children, tray, window }: { children: ReactNode; tray: any; window: any }) => {
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
  private static instance: TrayManager | null = null
  private tray: any | undefined
  private appWindow: any | undefined

  static async init(): Promise<{ tray: any | undefined; window: any | undefined }> {
    if (!TrayManager.instance) {
      TrayManager.instance = new TrayManager()
      await TrayManager.instance.initialize()
    }
    return {
      tray: TrayManager.instance.getTray(),
      window: TrayManager.instance.getWindow(),
    }
  }

  static async initIfSupported(): Promise<{ tray: any | undefined; window: any | undefined }> {
    if (isTauri() && isDesktop()) {
      return TrayManager.init()
    }
    // Return empty tray/window for mobile platforms or web
    return {
      tray: undefined,
      window: isTauri() ? (await loadTauriModules(), tauriWindow?.getCurrentWindow()) : undefined,
    }
  }

  private getTray() {
    return this.tray
  }

  private getWindow() {
    return this.appWindow
  }

  private async handleShowClick() {
    if (!isTauri() || !this.appWindow) {
      return
    }

    await loadTauriModules()
    if (!tauriCore) {
      return
    }

    await this.appWindow.show()
    await this.appWindow.setSkipTaskbar(false)

    if (isDesktop()) {
      try {
        await tauriCore.invoke('toggle_dock_icon', { show: true })
      } catch (error) {
        console.error('Failed to show dock icon:', error)
      }
    }
  }

  private async handleQuitClick() {
    if (!isTauri()) {
      // In web environment, just close the window/tab
      window.close()
      return
    }

    await loadTauriModules()
    if (tauriProcess) {
      await tauriProcess.exit(0)
    }
  }

  private async setupWindowBehavior() {
    if (!isTauri() || !this.appWindow) {
      return
    }

    await loadTauriModules()
    if (!tauriCore) {
      return
    }

    this.appWindow.onCloseRequested(async (event: any) => {
      if (!this.appWindow) {
        return
      }

      event.preventDefault()
      await this.appWindow.hide()
      await this.appWindow.setSkipTaskbar(true)

      if (isDesktop()) {
        try {
          await tauriCore.invoke('toggle_dock_icon', { show: false })
        } catch (error) {
          console.error('Failed to hide dock icon:', error)
        }
      }
    })
  }

  private async initialize() {
    if (!isTauri()) {
      // Web environment - no tray support
      return {
        tray: undefined,
        window: undefined,
      }
    }

    await loadTauriModules()
    if (!tauriWindow) {
      console.error('Failed to load Tauri window module')
      return { tray: undefined, window: undefined }
    }

    this.appWindow = tauriWindow.getCurrentWindow()

    // Only set up tray-related features on desktop platforms
    if (isDesktop() && tauriMenu && tauriTray) {
      await this.setupWindowBehavior()

      try {
        const menu = await tauriMenu.Menu.new({
          items: [
            {
              id: 'show',
              text: 'Show',
              action: this.handleShowClick.bind(this),
            },
            {
              id: 'quit',
              text: 'Quit',
              action: this.handleQuitClick.bind(this),
            },
          ],
        })

        this.tray = await tauriTray.TrayIcon.new({
          title: 'Thunderbolt',
          tooltip: 'Thunderbolt',
          menu,
        })
      } catch (error) {
        console.error('Failed to create tray:', error)
      }
    }

    return {
      tray: this.tray,
      window: this.appWindow,
    }
  }
}
