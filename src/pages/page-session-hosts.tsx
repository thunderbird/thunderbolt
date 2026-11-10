/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { CSSProperties } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useSidebarWebview } from '@/content-view/use-sidebar-webview'
import { SandboxedHtmlFrame } from '@/components/artifact/sandboxed-html-frame'
import { browserController } from '@/browser/browser-controller'
import { invokeBrowserAction } from '@/browser/native-action'
import { isMobile, isTauri, isTauriDesktop } from '@/lib/platform'
import { pageController } from './page-controller'
import { usePageStore, openUrlPage, type PageSession } from './page-store'
import { usePagePlacement } from './use-page-placement'
import { pageObservationSchema } from './page-observation'
import { useLocalAppUrl } from '@/local-apps/use-local-app-url'
import { MobilePageHost } from './mobile-page-host'
import { waitForPagePresentation } from './page-presentation'
import { waitForPageLoad } from './page-load'
import { preservePageFocus } from './preserve-page-focus'

const htmlCapabilities = {
  observe: true,
  selectElement: true,
  navigate: false,
  declaredTools: false,
  screenshot: false,
  pointerInput: 'synthetic',
  keyboardInput: 'synthetic',
} as const
const desktopCapabilities = {
  ...htmlCapabilities,
  navigate: true,
  screenshot: true,
  pointerInput: 'native',
  keyboardInput: 'native',
} as const

const HtmlPageHost = ({ session }: { session: PageSession }) => {
  const source = session.page.source
  const unregister = useRef<(() => void) | undefined>(undefined)
  useEffect(() => () => unregister.current?.(), [])
  if (source.kind !== 'html') {
    return null
  }
  return (
    <SandboxedHtmlFrame
      html={source.html}
      title={session.page.title}
      onHeightChange={(height) => {
        if (session.presentation === 'inline' && Math.abs(height - session.height) > 1) {
          usePageStore.getState().update(session.id, { height })
        }
      }}
      onError={(error) => usePageStore.getState().update(session.id, { error })}
      onRequestReady={(request) => {
        unregister.current?.()
        if (!request) {
          unregister.current = undefined
          return
        }
        unregister.current = pageController.register(session.id, {
          capabilities: isMobile()
            ? { ...htmlCapabilities, pointerInput: 'none', keyboardInput: 'none' }
            : htmlCapabilities,
          present: (signal) => waitForPagePresentation(session.id, signal),
          snapshot: async () => pageObservationSchema.parse(await request('page/snapshot', {})),
          act: (action) =>
            preservePageFocus(session.id, async () => {
              if ((await request('page/action', action)) !== true) {
                throw new Error('Page interaction failed. Observe the page again.')
              }
            }),
          picker: async (enabled, requestId) => {
            await request('page/picker', { enabled, requestId })
          },
          pollPicker: (requestId) => request('page/pick', { requestId }),
        })
      }}
    />
  )
}

const DesktopPageHost = ({ session, visible }: { session: PageSession; visible: boolean }) => {
  const ref = useRef<HTMLDivElement>(null)
  const source = session.page.source
  const onLocalError = useCallback(
    (error: string | null) => usePageStore.getState().update(session.id, { error }),
    [session.id],
  )
  const localPreview = useLocalAppUrl(source.kind === 'local-app' ? source.appId : undefined, onLocalError)
  const url = source.kind === 'url' ? source.url : localPreview.url
  // A restarted local server may reuse its port; recreate config to navigate to the new process.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const config = useMemo(() => (url ? { url } : null), [url, localPreview.generation])
  const browser = useSidebarWebview(config, ref, !visible, {
    tabId: session.id,
    onStateChange: (browser) => usePageStore.getState().update(session.id, { browser }),
    onNewTab: (url) => openUrlPage(url),
  })
  const label = browser.webview?.label
  const { isInitialized, navigate, goBack, goForward, reload, stop, present, readState } = browser
  useEffect(() => {
    usePageStore.getState().update(session.id, { nativeLabel: label })
  }, [session.id, label])
  useEffect(() => {
    if (!label || !isInitialized) {
      return
    }
    return pageController.register(session.id, {
      capabilities: desktopCapabilities,
      present: async (signal) => {
        await waitForPagePresentation(session.id, signal)
        signal?.throwIfAborted()
        await present()
      },
      snapshot: async (screenshot, signal) => {
        await waitForPageLoad(readState, signal)
        await waitForPagePresentation(session.id, signal)
        await present()
        signal?.throwIfAborted()
        const result = await invoke('browser_agent_snapshot', { label, screenshot })
        signal?.throwIfAborted()
        return pageObservationSchema.parse(result)
      },
      navigate: async (navigation, signal) => {
        signal?.throwIfAborted()
        const succeeded = await (navigation.type === 'navigate'
          ? navigate(navigation.url)
          : navigation.type === 'back'
            ? goBack()
            : navigation.type === 'forward'
              ? goForward()
              : navigation.type === 'reload'
                ? reload()
                : stop())
        if (!succeeded) {
          throw new Error('Page navigation failed')
        }
      },
      act: async (action, signal) => {
        signal?.throwIfAborted()
        await invokeBrowserAction(label, action, signal)
        signal?.throwIfAborted()
      },
      picker: async (enabled, requestId) => {
        await invoke('browser_set_picker', { label, enabled, requestId })
      },
      pollPicker: (requestId) => invoke('browser_poll_picker', { label, requestId }),
    })
  }, [label, isInitialized, navigate, goBack, goForward, reload, stop, present, readState, session.id])
  useEffect(() => {
    usePageStore.getState().update(session.id, { error: browser.error })
  }, [session.id, browser.error])
  return <div ref={ref} className="h-full w-full" />
}

const PageSessionHost = ({ session, active }: { session: PageSession; active: boolean }) => {
  const placement = usePagePlacement(session, active)
  const style: CSSProperties = {
    position: 'fixed',
    left: placement.x,
    top: placement.y,
    width: placement.width,
    height: placement.height,
    clipPath: placement.clip,
    visibility: placement.visible ? 'visible' : 'hidden',
    pointerEvents: placement.visible ? 'auto' : 'none',
    zIndex: session.presentation === 'inline' ? 10 : 30,
  }
  const nativePage = session.page.source.kind !== 'html'
  if (nativePage && !isTauri()) {
    return null
  }
  return (
    <div data-page-host={session.id} aria-hidden={!placement.visible} inert={!placement.visible} style={style}>
      {session.page.source.kind === 'html' ? (
        <HtmlPageHost session={session} />
      ) : isTauriDesktop() ? (
        <DesktopPageHost session={session} visible={placement.visible} />
      ) : (
        <MobilePageHost session={session} visible={placement.visible} />
      )}
    </div>
  )
}

/** Permanent renderer owners sit outside route and sidebar trees so presentation cannot reload a page. */
export const PageSessionHosts = () => {
  const sessions = usePageStore((state) => state.sessions)
  const activeId = usePageStore((state) => state.activeId)
  useEffect(
    () =>
      browserController.registerPanel({
        listTabs: () =>
          usePageStore.getState().sessions.map((session) => ({
            id: session.id,
            url: session.browser.url,
            title: session.browser.title,
            isLoading: session.browser.isLoading,
            active: usePageStore.getState().activeId === session.id,
          })),
      }),
    [],
  )
  return (
    <>
      {sessions.map((session) => (
        <PageSessionHost
          key={session.id}
          session={session}
          active={session.presentation === 'inline' || session.id === activeId}
        />
      ))}
    </>
  )
}
