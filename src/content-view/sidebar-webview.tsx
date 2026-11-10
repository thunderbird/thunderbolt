/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useRef } from 'react'
import { browserController } from '@/browser/browser-controller'
import { isTauriDesktop } from '@/lib/platform'
import { BrowserTabContent } from './browser-tab-content'
import { ContentViewHeader } from './header'
import { useBrowserTabs } from './use-browser-tabs'
import type { SidebarWebviewConfig } from './use-sidebar-webview'

type SidebarWebviewProps = {
  config: SidebarWebviewConfig | null
  onClose?: () => void
  hidden?: boolean
  chatThreadId?: string | null
  onReferenceAttached?: () => void
}

/** Desktop browser chrome with an independent native webview for each open tab. */
export const SidebarWebview = (props: SidebarWebviewProps) => {
  const { t } = useLingui()
  if (!isTauriDesktop()) {
    return (
      <div className="flex h-full flex-col">
        <ContentViewHeader title={t`Browser`} onClose={() => props.onClose?.()} />
        <div className="flex flex-1 items-center justify-center p-4 text-center">
          <p className="text-sm text-muted-foreground">
            <Trans>The browser is only available in the desktop app.</Trans>
          </p>
        </div>
      </div>
    )
  }
  return props.config ? <DesktopBrowser {...props} config={props.config} /> : null
}

const DesktopBrowser = ({
  config,
  onClose,
  hidden,
  chatThreadId,
  onReferenceAttached,
}: SidebarWebviewProps & { config: SidebarWebviewConfig }) => {
  const tabs = useBrowserTabs(config)
  const closeBrowser = () => {
    tabs.closeAll()
    config.onClose?.()
    onClose?.()
  }
  const closeTab = (id: string, options?: { focusTab?: boolean }) => {
    tabs.closeTab(id)
    if (tabs.tabs.length === 1 && tabs.tabs[0].id === id) {
      closeBrowser()
    }
    const index = tabs.tabs.findIndex((tab) => tab.id === id)
    const nextId = tabs.activeId === id ? (tabs.tabs[index + 1]?.id ?? tabs.tabs[index - 1]?.id) : tabs.activeId
    if (nextId && options?.focusTab !== false) {
      requestAnimationFrame(() => {
        document
          .getElementById(`browser-tab-panel-${nextId}`)
          ?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
          ?.focus()
      })
    }
  }
  const controlRef = useRef({ tabs, closeTab })
  controlRef.current = { tabs, closeTab }
  useEffect(
    () =>
      browserController.registerPanel({
        listTabs: () =>
          controlRef.current.tabs.tabs.map((tab) => ({
            id: tab.id,
            url: tab.url,
            title: tab.title,
            isLoading: tab.isLoading,
            active: controlRef.current.tabs.activeId === tab.id,
          })),
        openTab: (url, options) => controlRef.current.tabs.openTab(url, options),
        selectTab: (id) => controlRef.current.tabs.selectTab(id),
        closeTab: (id, options) => controlRef.current.closeTab(id, options),
      }),
    [],
  )
  return (
    <div data-browser-panel className="relative h-full min-h-0 w-full min-w-0 bg-background">
      {tabs.tabs.map((tab) => (
        <BrowserTabContent
          key={tab.id}
          tab={tab}
          tabs={tabs}
          hidden={Boolean(hidden || tabs.activeId !== tab.id)}
          onClose={closeBrowser}
          onCloseTab={closeTab}
          chatThreadId={chatThreadId ?? null}
          onReferenceAttached={onReferenceAttached}
        />
      ))}
    </div>
  )
}
