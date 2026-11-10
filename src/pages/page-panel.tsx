/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Maximize2,
  MousePointer2,
  PanelTop,
  PinOff,
  RotateCw,
  X,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { PanelRightRounded } from '@/components/icons/panel-right-rounded'
import { BrowserAddressBar } from '@/content-view/browser-address-bar'
import { BrowserNewTab } from '@/content-view/browser-new-tab'
import { BrowserToolbarButton } from '@/content-view/browser-toolbar-button'
import { BrowserAgentStatus } from '@/browser/browser-agent-status'
import { isFramelessControlsPlatform, isTauri, isTauriDesktop } from '@/lib/platform'
import { usePageStore } from './page-store'
import { PageSlot } from './page-slot'
import { PageTabStrip } from './page-tab-strip'
import { usePagePanelState } from './use-page-panel-state'

/** Chrome and placement only: running documents belong to the app-level permanent hosts. */
export const PagePanel = ({
  onClose,
  hidden = false,
  sessionId,
  mode = 'sidebar',
  onRestore,
  headerStart,
}: {
  onClose: () => void
  hidden?: boolean
  sessionId?: string
  mode?: 'sidebar' | 'expanded'
  onRestore?: () => void
  headerStart?: ReactNode
}) => {
  const { t } = useLingui()
  const state = usePagePanelState({ sessionId, mode, onClose, onRestore, hidden })
  const session = state.session
  if (hidden || !session) {
    return null
  }
  const blank = session.page.source.kind === 'url' && session.browser.url === 'about:blank'
  const webFallback =
    (!isTauri() && session.page.source.kind !== 'html' && !blank) ||
    (session.page.source.kind === 'local-app' && !isTauriDesktop())
  const canPick = state.picker.canPick && !webFallback
  const actions = (
    <>
      <BrowserToolbarButton
        label={state.picker.isPicking ? t`Cancel element selection` : t`Select element on page`}
        aria-pressed={state.picker.isPicking}
        disabled={!canPick}
        onClick={state.picker.toggle}
      >
        <MousePointer2 className="size-4" />
      </BrowserToolbarButton>
      <BrowserToolbarButton
        label={mode === 'expanded' ? t`Restore to sidebar` : t`Expand page`}
        onClick={mode === 'expanded' ? onRestore : state.expand}
      >
        {mode === 'expanded' ? <PanelRightRounded className="size-4" /> : <Maximize2 className="size-4" />}
      </BrowserToolbarButton>
      <BrowserToolbarButton label={t`Close browser`} onClick={onClose}>
        <X className="size-4" />
      </BrowserToolbarButton>
    </>
  )
  return (
    <section
      id={`browser-tab-panel-${session.id}`}
      data-page-panel
      data-browser-tab-panel
      className="flex h-full min-h-0 w-full flex-col bg-background"
      aria-label={t`Browser`}
    >
      <div
        data-page-header
        className="shrink-0"
        style={isFramelessControlsPlatform() ? { paddingRight: 'var(--window-controls-width)' } : undefined}
      >
        {session.chrome === 'browser' ? (
          <PageTabStrip
            sessions={state.tabs}
            activeId={session.id}
            onSelect={state.select}
            onClose={state.closeTab}
            onCloseAll={state.closeAllTabs}
            onNewTab={state.newTab}
            onPin={(target, chrome) => {
              void state.pinPage(target, chrome)
            }}
            onUnpin={(id) => {
              void state.unpin(id)
            }}
            pinnedIds={state.pinnedIds}
            actions={actions}
            headerStart={headerStart}
          />
        ) : (
          <div
            data-tauri-drag-region={isTauriDesktop() || undefined}
            className="flex shrink-0 items-center border-b p-2"
          >
            {headerStart}
            <div data-tauri-drag-region={isTauriDesktop() || undefined} className="flex-1 self-stretch" />
            <BrowserToolbarButton
              label={t`Show browser controls`}
              onClick={() => usePageStore.getState().update(session.id, { chrome: 'browser' })}
            >
              <PanelTop className="size-4" />
            </BrowserToolbarButton>
            {state.pinnedIds.has(session.page.id) && (
              <BrowserToolbarButton
                label={t`Unpin`}
                onClick={() => {
                  void state.unpin(session.page.id)
                }}
              >
                <PinOff className="size-4" />
              </BrowserToolbarButton>
            )}
            {actions}
          </div>
        )}
      </div>
      {session.chrome === 'browser' && session.page.source.kind !== 'html' && (
        <div data-page-address-row className="flex shrink-0 items-center gap-1 border-b px-2 py-2">
          <BrowserAddressBar
            key={session.id}
            url={blank ? '' : session.browser.url}
            inputRef={state.addressRef}
            disabled={state.busy}
            onNavigate={(url) => state.runNavigation({ type: 'navigate', url })}
            navigation={
              <>
                <BrowserToolbarButton
                  label={t`Go back`}
                  disabled={!session.browser.canGoBack || state.busy}
                  onClick={() => {
                    void state.runNavigation({ type: 'back' })
                  }}
                >
                  <ArrowLeft className="size-4" />
                </BrowserToolbarButton>
                <BrowserToolbarButton
                  label={t`Go forward`}
                  disabled={!session.browser.canGoForward || state.busy}
                  onClick={() => {
                    void state.runNavigation({ type: 'forward' })
                  }}
                >
                  <ArrowRight className="size-4" />
                </BrowserToolbarButton>
                <BrowserToolbarButton
                  label={session.browser.isLoading ? t`Stop loading` : t`Reload page`}
                  disabled={blank || webFallback || state.busy}
                  onClick={() => {
                    void state.runNavigation({ type: session.browser.isLoading ? 'stop' : 'reload' })
                  }}
                >
                  {session.browser.isLoading ? <X className="size-4" /> : <RotateCw className="size-4" />}
                </BrowserToolbarButton>
              </>
            }
          />
        </div>
      )}
      <BrowserAgentStatus tabId={session.id} />
      {(state.error || session.error || state.picker.error) && (
        <p role="alert" className="shrink-0 border-b px-3 py-2 text-sm text-destructive">
          {state.picker.error ? (
            <Trans>Could not select an element on this page.</Trans>
          ) : state.error ? (
            <Trans>Could not complete this page action. Please try again.</Trans>
          ) : (
            session.error
          )}
        </p>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {blank ? (
          <BrowserNewTab />
        ) : webFallback ? (
          <div className="m-auto max-w-sm space-y-4 p-6 text-center text-sm text-muted-foreground">
            {session.page.source.kind === 'url' ? (
              <>
                <p>
                  <Trans>This website opens in your browser.</Trans>
                </p>
                <a
                  className="inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-foreground hover:bg-accent"
                  href={session.browser.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink className="size-4" />
                  <Trans>Open in your browser</Trans>
                </a>
              </>
            ) : (
              <p>
                <Trans>This local app is available in the desktop app on the computer where it was created.</Trans>
              </p>
            )}
          </div>
        ) : (
          <PageSlot sessionId={session.id} mode={mode} />
        )}
      </div>
    </section>
  )
}
