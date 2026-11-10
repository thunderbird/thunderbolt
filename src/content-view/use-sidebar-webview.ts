/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isTauriDesktop } from '@/lib/platform'
import { browserController } from '@/browser/browser-controller'
import { invoke } from '@tauri-apps/api/core'
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebview, Webview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'

export type SidebarWebviewConfig = {
  url: string
  onClose?: () => void
}

export type SidebarBrowserState = {
  url: string
  title: string
  faviconUrls?: string[]
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

type SidebarWebviewOptions = {
  tabId?: string
  onStateChange?: (state: SidebarBrowserState) => void
  onNewTab?: (url: string) => void
}

type BrowserAction = 'back' | 'forward' | 'reload' | 'stop'
type BrowserSession = {
  webview: Webview | null
  navigate: (url: string) => Promise<boolean>
  action: (action: BrowserAction) => Promise<boolean>
  close: () => Promise<void>
  updateVisibility: () => Promise<void>
}

/** Measures the page viewport, independent of the browser toolbar's height. */
const getViewportBounds = async (container: HTMLElement) => {
  const [origin, scaleFactor] = await Promise.all([getCurrentWebview().position(), getCurrentWindow().scaleFactor()])
  const rect = container.getBoundingClientRect()
  return {
    x: Math.floor(rect.left + origin.x / scaleFactor),
    y: Math.floor(rect.top + origin.y / scaleFactor),
    width: Math.max(1, Math.floor(rect.width)),
    height: Math.max(1, Math.floor(rect.height)),
  }
}

/** Keeps a native browser alive while navigating and synchronizes its viewport and engine state. */
export const useSidebarWebview = (
  config: SidebarWebviewConfig | null,
  containerRef: RefObject<HTMLElement | null>,
  hidden = false,
  options: SidebarWebviewOptions = {},
) => {
  const [state, setState] = useState<SidebarBrowserState & { isInitialized: boolean; error: string | null }>({
    url: config?.url ?? '',
    title: '',
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    isInitialized: false,
    error: null,
  })
  const [retry, setRetry] = useState(0)
  const sessionRef = useRef<BrowserSession | null>(null)
  const configRef = useRef(config)
  const hiddenRef = useRef(hidden)
  const optionsRef = useRef(options)
  configRef.current = config
  hiddenRef.current = hidden
  optionsRef.current = options
  const enabled = Boolean(config?.url) && isTauriDesktop()

  useEffect(() => {
    if (!enabled || !containerRef.current) {
      return
    }

    const label = `sidebar-webview-${crypto.randomUUID()}`
    let active = true
    let created = false
    let closing: Promise<void> | null = null
    let frame: number | undefined
    let poll: ReturnType<typeof setTimeout> | undefined
    let revision = 0
    let queue = Promise.resolve()
    let presentationQueue = Promise.resolve()
    let blankPage = configRef.current?.url === 'about:blank'
    const unlisteners: (() => void)[] = []
    const reportError = (error: unknown) => {
      if (active) {
        setState((previous) => ({ ...previous, error: String(error), isLoading: false }))
      }
    }
    const refresh = async () => {
      const requestedRevision = ++revision
      const next = await invoke<SidebarBrowserState>('browser_get_state', { label })
      if (!active || requestedRevision !== revision) {
        return
      }
      const wasBlank = blankPage
      blankPage = next.url === 'about:blank'
      setState((previous) => ({ ...previous, ...next }))
      optionsRef.current.onStateChange?.(next)
      if (wasBlank !== blankPage) {
        await updatePresentation(true)
      }
    }
    const pollState = async () => {
      try {
        await refresh()
      } catch (error) {
        reportError(error)
      } finally {
        if (active) {
          poll = setTimeout(pollState, 500)
        }
      }
    }
    const execute = async (command: string, args: Record<string, string>) => {
      if (!active || !session.webview) {
        return false
      }
      let succeeded = false
      const previous = queue
      const pending = (async () => {
        await previous
        if (!active) {
          return
        }
        revision += 1
        try {
          await invoke(command, { label, ...args })
          if (!active) {
            return
          }
          setState((previous) => ({ ...previous, error: null }))
          await refresh()
          succeeded = active
        } catch (error) {
          reportError(error)
        }
      })()
      queue = pending
      await pending
      return succeeded
    }
    const updatePresentation = (updateVisibility = false) => {
      const previous = presentationQueue
      const pending = (async () => {
        await previous
        if (!active || !session.webview || !containerRef.current) {
          return
        }
        try {
          if (hiddenRef.current || blankPage) {
            if (updateVisibility) {
              await session.webview.hide()
            }
            return
          }
          const bounds = await getViewportBounds(containerRef.current)
          if (!active) {
            return
          }
          await session.webview.setPosition(new LogicalPosition(bounds.x, bounds.y))
          if (!active) {
            return
          }
          await session.webview.setSize(new LogicalSize(bounds.width, bounds.height))
          if (active && updateVisibility) {
            // A switch while measuring must not reveal a tab that is now inactive.
            if (hiddenRef.current || blankPage) {
              await session.webview.hide()
            } else {
              await session.webview.show()
              try {
                await invoke('browser_resize_raise')
              } catch (error) {
                console.error('Could not raise browser resize grip', error)
              }
            }
          }
        } catch (error) {
          reportError(error)
        }
      })()
      presentationQueue = pending
      return pending
    }
    const requestPositionUpdate = () => {
      if (frame !== undefined) {
        cancelAnimationFrame(frame)
      }
      frame = requestAnimationFrame(() => void updatePresentation())
    }
    const observer = new ResizeObserver(requestPositionUpdate)
    const closeNative = async () => {
      if (!created) {
        return
      }
      closing ??= invoke<void>('browser_close', { label })
      await closing
    }
    const session: BrowserSession = {
      webview: null,
      navigate: (nextUrl) => execute('browser_navigate', { url: nextUrl }),
      action: (action) => execute('browser_action', { action }),
      updateVisibility: () => updatePresentation(true),
      close: async () => {
        active = false
        if (frame !== undefined) {
          cancelAnimationFrame(frame)
        }
        if (poll !== undefined) {
          clearTimeout(poll)
        }
        observer.disconnect()
        unlisteners.splice(0).forEach((unlisten) => unlisten())
        window.removeEventListener('unload', handleUnload)
        await closeNative()
      },
    }
    sessionRef.current = session
    const handleUnload = () => void session.close().catch(console.error)
    const initialize = async () => {
      try {
        // Measure after layout, including the toolbar and any browser status banner.
        await new Promise<void>((resolve) => {
          frame = requestAnimationFrame(() => resolve())
        })
        if (!active || !containerRef.current || !configRef.current) {
          return
        }
        const initialUrl = configRef.current.url
        setState((previous) => ({ ...previous, isInitialized: false, isLoading: true, error: null }))
        const bounds = await getViewportBounds(containerRef.current)
        if (!active) {
          return
        }
        // Subscribe before the page starts loading: its startup script may open
        // a tab before creation and the first native-state read have completed.
        const unlisten = await listen<{ label: string; url: string }>('browser-new-tab', ({ payload }) => {
          if (active && payload.label === label) {
            optionsRef.current.onNewTab?.(payload.url)
          }
        })
        if (!active) {
          unlisten()
          return
        }
        unlisteners.push(unlisten)
        blankPage = initialUrl === 'about:blank'
        await invoke('browser_create', {
          label,
          url: initialUrl,
          bounds,
          // Creation can finish after another tab is selected. Reveal only once
          // the latest visibility and viewport have been applied below.
          hidden: true,
        })
        created = true
        if (!active) {
          await closeNative()
          return
        }
        session.webview = await Webview.getByLabel(label)
        if (!active) {
          await closeNative()
          return
        }
        if (!session.webview) {
          throw new Error('Browser webview was not created')
        }
        if (optionsRef.current.tabId) {
          unlisteners.push(
            browserController.registerSession(optionsRef.current.tabId, {
              label,
              present: () => session.updateVisibility(),
            }),
          )
        }
        await session.updateVisibility()
        if (!active) {
          return
        }
        setState((previous) => ({ ...previous, isInitialized: true }))
        if (configRef.current?.url && configRef.current.url !== initialUrl) {
          await session.navigate(configRef.current.url)
        }
        if (!active) {
          return
        }
        observer.observe(containerRef.current)
        window.addEventListener('unload', handleUnload)
        const appWindow = getCurrentWindow()
        for (const subscribe of [appWindow.onResized.bind(appWindow), appWindow.onMoved.bind(appWindow)]) {
          const unlisten = await subscribe(requestPositionUpdate)
          if (!active) {
            unlisten()
            return
          }
          unlisteners.push(unlisten)
        }
        await updatePresentation()
        if (active) {
          void pollState()
        }
      } catch (error) {
        reportError(error)
        if (active) {
          setState((previous) => ({ ...previous, isInitialized: false }))
        }
        await session.close().catch(console.error)
      }
    }
    void initialize()
    return () => {
      void session.close().catch(console.error)
      if (sessionRef.current === session) {
        sessionRef.current = null
      }
    }
  }, [enabled, containerRef, retry])

  // A new chat link navigates the existing browser, preserving its native history.
  useEffect(() => {
    if (config?.url) {
      void sessionRef.current?.navigate(config.url)
    }
  }, [config])

  useEffect(() => {
    void sessionRef.current?.updateVisibility()
  }, [hidden])

  const navigate = useCallback(async (nextUrl: string) => (await sessionRef.current?.navigate(nextUrl)) ?? false, [])
  const goBack = useCallback(async () => (await sessionRef.current?.action('back')) ?? false, [])
  const goForward = useCallback(async () => (await sessionRef.current?.action('forward')) ?? false, [])
  const stop = useCallback(async () => (await sessionRef.current?.action('stop')) ?? false, [])
  const reload = useCallback(async () => {
    if (!state.isInitialized) {
      setRetry((previous) => previous + 1)
      return true
    }
    return (await sessionRef.current?.action('reload')) ?? false
  }, [state.isInitialized])
  const closeWebview = useCallback(async () => {
    const session = sessionRef.current
    if (!session) {
      return
    }
    await session.close()
    if (sessionRef.current !== session) {
      return
    }
    sessionRef.current = null
    setState((previous) => ({ ...previous, isInitialized: false, isLoading: false }))
    configRef.current?.onClose?.()
  }, [])

  return {
    ...state,
    webview: sessionRef.current?.webview ?? null,
    navigate,
    goBack,
    goForward,
    reload,
    stop,
    closeWebview,
  }
}
