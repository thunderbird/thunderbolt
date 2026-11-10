/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { ArrowLeft, ArrowRight, Check, Copy, ExternalLink, MousePointerClick, RotateCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { BrowserAgentStatus } from '@/browser/browser-agent-status'
import { BrowserAddressBar } from './browser-address-bar'
import { BrowserNewTab } from './browser-new-tab'
import { BrowserToolbarButton } from './browser-toolbar-button'
import { BrowserTabStrip } from './browser-tab-strip'
import { useSidebarBrowserState } from './use-sidebar-browser-state'
import type { useBrowserTabs, BrowserTab } from './use-browser-tabs'
import { useBrowserElementPicker } from './use-browser-element-picker'

export const BrowserTabContent = ({
  tab,
  tabs,
  onClose,
  onCloseTab,
  hidden,
  chatThreadId,
  onReferenceAttached,
}: {
  tab: BrowserTab
  tabs: ReturnType<typeof useBrowserTabs>
  onClose: () => void
  onCloseTab: (id: string) => void
  hidden: boolean
  chatThreadId: string | null
  onReferenceAttached?: () => void
}) => {
  const { t } = useLingui()
  const {
    browser,
    viewportRef,
    addressRef,
    actionError,
    isCopied,
    currentUrl,
    handleClose,
    handleCopy,
    handleOpenExternal,
  } = useSidebarBrowserState({
    tabId: tab.id,
    config: tab.config,
    onClose,
    hidden,
    focusAddress: tab.focusAddress,
    onStateChange: (state) => tabs.updateTab(tab.id, state),
    onNewTab: tabs.openTab,
    onCloseTab: () => onCloseTab(tab.id),
    onNextTab: () => tabs.cycleTab(1),
    onPreviousTab: () => tabs.cycleTab(-1),
  })
  const picker = useBrowserElementPicker({
    tabId: tab.id,
    label: browser.webview?.label ?? null,
    url: browser.url,
    chatThreadId,
    enabled: browser.isInitialized && !browser.isLoading && !hidden,
    onAttached: onReferenceAttached,
  })
  const title = browser.url === 'about:blank' ? t`New tab` : browser.title || t`Browser`

  return (
    <div
      data-browser-tab-panel
      id={`browser-tab-panel-${tab.id}`}
      role="tabpanel"
      aria-label={title}
      aria-hidden={hidden || undefined}
      inert={hidden}
      className="absolute inset-0 flex min-h-0 min-w-0 flex-col bg-background"
      style={{ visibility: hidden ? 'hidden' : 'visible' }}
    >
      <BrowserTabStrip
        tabs={tabs.tabs}
        activeId={tabs.activeId}
        visible={!hidden}
        onSelect={tabs.selectTab}
        onClose={onCloseTab}
        onNewTab={() => tabs.openTab()}
        actions={
          <>
            <BrowserToolbarButton
              label={picker.isPicking ? t`Cancel selection` : t`Select element`}
              aria-pressed={picker.isPicking}
              disabled={!picker.canPick}
              onClick={picker.toggle}
            >
              <MousePointerClick className="size-4" />
            </BrowserToolbarButton>
            <BrowserToolbarButton
              label={isCopied ? t`Copied` : t`Copy URL`}
              disabled={!currentUrl}
              onClick={handleCopy}
            >
              {isCopied ? <Check className="size-4" /> : <Copy className="size-4" />}
            </BrowserToolbarButton>
            <BrowserToolbarButton label={t`Open in browser`} disabled={!currentUrl} onClick={handleOpenExternal}>
              <ExternalLink className="size-4" />
            </BrowserToolbarButton>
            <BrowserToolbarButton label={t`Close browser`} onClick={handleClose}>
              <X className="size-4" />
            </BrowserToolbarButton>
          </>
        }
      />
      <div
        role="toolbar"
        aria-label={t`Browser navigation`}
        className="flex shrink-0 items-start gap-1 border-b px-2 py-2"
      >
        <div className="flex h-9 shrink-0 items-center">
          <BrowserToolbarButton label={t`Go back`} disabled={!browser.canGoBack} onClick={() => void browser.goBack()}>
            <ArrowLeft className="size-4" />
          </BrowserToolbarButton>
          <BrowserToolbarButton
            label={t`Go forward`}
            disabled={!browser.canGoForward}
            onClick={() => void browser.goForward()}
          >
            <ArrowRight className="size-4" />
          </BrowserToolbarButton>
          <BrowserToolbarButton
            label={browser.isLoading ? t`Stop loading` : t`Reload page`}
            disabled={!browser.isInitialized}
            onClick={() => void (browser.isLoading ? browser.stop() : browser.reload())}
          >
            {browser.isLoading ? <X className="size-4" /> : <RotateCw className="size-4" />}
          </BrowserToolbarButton>
        </div>
        <BrowserAddressBar
          url={browser.url === 'about:blank' ? '' : browser.url}
          inputRef={addressRef}
          disabled={!browser.isInitialized}
          onNavigate={browser.navigate}
        />
      </div>
      {(browser.error || actionError || picker.error) && (
        <div
          role="alert"
          className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2 text-sm text-destructive"
        >
          <span>
            {browser.error ? (
              <Trans>Could not load this page. Try another address or reload.</Trans>
            ) : (
              <Trans>Could not complete this action. Please try again.</Trans>
            )}
          </span>
          {browser.error && (
            <Button variant="ghost" size="sm" onClick={() => void browser.reload()}>
              <Trans>Retry</Trans>
            </Button>
          )}
        </div>
      )}
      {picker.isPicking && (
        <div
          role="status"
          className="flex h-6 shrink-0 items-center gap-1.5 border-b px-3 text-xs text-muted-foreground"
        >
          <span className="truncate">
            <Trans>Click an element to reference it in chat. Press Escape to cancel.</Trans>
          </span>
        </div>
      )}
      <BrowserAgentStatus tabId={tab.id} />
      <div ref={viewportRef} className="relative min-h-0 w-full flex-1" aria-label={t`Web page`}>
        {browser.isInitialized && browser.url === 'about:blank' && <BrowserNewTab />}
        {!browser.isInitialized && !browser.error && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            <Trans>Opening browser…</Trans>
          </div>
        )}
      </div>
    </div>
  )
}
