import { invoke } from '@tauri-apps/api/core'
import { Menu } from '@tauri-apps/api/menu'
import { TrayIcon } from '@tauri-apps/api/tray'
import { getCurrentWindow, Window } from '@tauri-apps/api/window'
import { exit } from '@tauri-apps/plugin-process'
import { createContext, ReactNode, useContext, useState } from 'react'

interface TrayContextType {
  tray: TrayIcon | undefined
  window: Window | undefined
}

const TrayContext = createContext<TrayContextType | undefined>(undefined)

export const useTray = () => {
  const context = useContext(TrayContext)
  if (context === undefined) {
    throw new Error('useTray must be used within a TrayProvider')
  }
  return context
}

interface TrayProviderProps {
  children: ReactNode
  tray: TrayIcon | undefined
  window: Window | undefined
}

export const TrayProvider = ({ children, tray, window }: TrayProviderProps) => {
  const [trayContext] = useState<TrayContextType>({ tray, window })

  return <TrayContext.Provider value={trayContext}>{children}</TrayContext.Provider>
}

export class TrayManager {
  private static instance: TrayManager | undefined
  private tray: TrayIcon | undefined
  private appWindow: Window | undefined

  private constructor() {
    this.tray = undefined
    this.appWindow = undefined
  }

  static async init(): Promise<{ tray: TrayIcon | undefined; window: Window | undefined }> {
    if (!TrayManager.instance) {
      TrayManager.instance = new TrayManager()
      await TrayManager.instance.initialize()
    }
    return {
      tray: TrayManager.instance.getTray(),
      window: TrayManager.instance.getWindow(),
    }
  }

  getTray(): TrayIcon | undefined {
    return this.tray
  }

  getWindow(): Window | undefined {
    return this.appWindow
  }

  async showWindow() {
    if (!this.appWindow) return

    await invoke('toggle_dock_icon', { show: true })

    await this.appWindow.show()
    await this.appWindow.setFocus()
  }

  private async handleShowClick() {
    await this.showWindow()
  }

  private async handleQuitClick() {
    await exit(0)
  }

  private async setupWindowBehavior() {
    if (!this.appWindow) return

    this.appWindow.onCloseRequested(async (event) => {
      if (!this.appWindow) return

      event.preventDefault()
      await this.appWindow.hide()
      await this.appWindow.setSkipTaskbar(true)

      await invoke('toggle_dock_icon', { show: false })
    })
  }

  private async initialize() {
    this.appWindow = getCurrentWindow()

    await this.setupWindowBehavior()

    const menu = await Menu.new({
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

    this.tray = await TrayIcon.new({
      title: 'Assist',
      tooltip: 'Assist',
      menu,
    })

    return {
      tray: this.tray,
      window: this.appWindow,
    }
  }

  destroy() {
    this.tray?.close()
    TrayManager.instance = undefined
  }
}
