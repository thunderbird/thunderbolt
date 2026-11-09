/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { msg } from '@lingui/core/macro'
import { i18n } from '@lingui/core'
import { createContext, useContext, type ReactNode } from 'react'
import { selectAppName } from '@/lib/branding-selectors'
import { useConfigStore } from '@/api/config-store'
import { quickEntryWindowLabel } from '@/quick-entry/events'
import type { TrayIconEvent } from '@tauri-apps/api/tray'
import type { Window } from '@tauri-apps/api/window'
import { isMacDesktop, isTauri, isTauriDesktop } from './platform'

// Lazy load Tauri modules only when needed
let tauriApp: any = null
let tauriCore: any = null
let tauriMenu: any = null
let tauriTray: any = null
let tauriWindow: any = null
let tauriProcess: any = null

const loadTauriModules = async () => {
  if (isTauri() && !tauriCore) {
    try {
      tauriApp = await import('@tauri-apps/api/app')
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

/** Show the main window and its Dock icon, undoing the close-to-tray in `setupWindowBehavior`. */
export const showMainWindow = async (appWindow: Pick<Window, 'show' | 'setSkipTaskbar'>) => {
  await appWindow.show()
  await appWindow.setSkipTaskbar(false)

  if (!isTauriDesktop()) {
    return
  }
  await loadTauriModules()
  try {
    await tauriCore?.invoke('toggle_dock_icon', { show: true })
  } catch (error) {
    console.error('Failed to show dock icon:', error)
  }
}

/** Logical gap between the Quick Entry panel and the bottom of the work area, which already excludes the Dock. */
const quickEntryBottomGap = 24

/** Bottom-center of the work area of the screen the cursor is on, falling back to the primary screen. */
const getQuickEntryPosition = async (quickEntry: Window) => {
  const cursor = await tauriWindow.cursorPosition()
  const monitor = (await tauriWindow.monitorFromPoint(cursor.x, cursor.y)) ?? (await tauriWindow.primaryMonitor())
  if (!monitor) {
    return null
  }
  const size = await quickEntry.outerSize()
  const { position, size: area } = monitor.workArea
  return new tauriWindow.PhysicalPosition(
    Math.round(position.x + (area.width - size.width) / 2),
    Math.round(position.y + area.height - size.height - quickEntryBottomGap * monitor.scaleFactor),
  )
}

/** DOM event the tray menu fires in the main webview for actions that need the router. */
export const trayCommandEvent = 'thunderbolt:tray-command'

/** What a tray menu item asks the app to do once the main window is showing. */
export type TrayCommand = 'new-chat' | 'settings'

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
    if (isTauriDesktop()) {
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
    await showMainWindow(this.appWindow)
    await this.appWindow.setFocus()
  }

  /** Bring the main window forward, then hand `command` to `useTrayCommands`, which owns the router. */
  private async runCommand(command: TrayCommand) {
    try {
      await this.handleShowClick()
      window.dispatchEvent(new CustomEvent<TrayCommand>(trayCommandEvent, { detail: command }))
    } catch (error) {
      console.error(`Failed to run tray command ${command}:`, error)
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

  /** Bring up the Quick Entry panel at the bottom center of the screen under the cursor. */
  private async showQuickEntry() {
    try {
      const quickEntry: Window | null = await tauriWindow?.Window.getByLabel(quickEntryWindowLabel)
      if (!quickEntry) {
        return
      }
      const position = await getQuickEntryPosition(quickEntry)
      if (position) {
        await quickEntry.setPosition(position)
      }
      await quickEntry.show()
      await quickEntry.setFocus()
    } catch (error) {
      console.error('Failed to show Quick Entry:', error)
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

      if (isTauriDesktop()) {
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
    if (isTauriDesktop() && tauriMenu && tauriTray) {
      await this.setupWindowBehavior()

      try {
        const appName = selectAppName(useConfigStore.getState().config)
        const version: string = await tauriApp.getVersion()
        const menu = await tauriMenu.Menu.new({
          items: [
            // Header: the app, with its version on a greyed-out row below, which
            // is as close as a native menu gets to a subtitle.
            {
              id: 'show',
              text: appName,
              icon: await tauriApp.defaultWindowIcon(),
              action: this.handleShowClick.bind(this),
            },
            { id: 'version', text: i18n._(msg`Version ${version}`), enabled: false },
            { item: 'Separator' },
            { id: 'new-chat', text: i18n._(msg`New Chat`), action: () => void this.runCommand('new-chat') },
            // The panel exists only on macOS (see tauri.macos.conf.json).
            ...(isMacDesktop()
              ? [{ id: 'quick-entry', text: i18n._(msg`Quick Entry`), action: () => void this.showQuickEntry() }]
              : []),
            { id: 'settings', text: i18n._(msg`Settings`), action: () => void this.runCommand('settings') },
            { item: 'Separator' },
            {
              id: 'quit',
              text: i18n._(msg`Quit`),
              accelerator: 'CmdOrCtrl+Q',
              action: this.handleQuitClick.bind(this),
            },
          ],
        })

        this.tray = await tauriTray.TrayIcon.new({
          icon: await tauriApp?.defaultWindowIcon(),
          // macOS template mode: alpha-only render that inverts with the menu
          // bar. No-op on Windows/Linux (they show the icon as-is).
          iconAsTemplate: true,
          tooltip: 'Thunderbolt',
          menu,
          // macOS: a left click opens Quick Entry, like other menu bar prompts;
          // the menu moves to a right click.
          ...(isMacDesktop() && {
            showMenuOnLeftClick: false,
            action: (event: TrayIconEvent) => {
              if (event.type === 'Click' && event.button === 'Left' && event.buttonState === 'Up') {
                void this.showQuickEntry()
              }
            },
          }),
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
