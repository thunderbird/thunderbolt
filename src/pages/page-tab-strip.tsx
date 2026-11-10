/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { AppWindow, LoaderCircle, Pin, PinOff, Plus, X, CopyX } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import type { PageChrome } from '@shared/page-protocol'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { BrowserToolbarButton } from '@/content-view/browser-toolbar-button'
import { isTauriDesktop } from '@/lib/platform'
import { cn } from '@/lib/utils'
import type { PageSession } from './page-store'
import { canPinPage } from './page-display'
import { PageIcon } from './page-icon'

export const PageTabStrip = ({
  sessions,
  activeId,
  onSelect,
  onClose,
  onCloseAll,
  onNewTab,
  onPin,
  onUnpin,
  pinnedIds,
  actions,
  headerStart,
}: {
  sessions: PageSession[]
  activeId: string
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onCloseAll: () => void
  onNewTab?: () => void
  onPin: (session: PageSession, chrome: PageChrome) => void
  onUnpin: (id: string) => void
  pinnedIds: Set<string>
  headerStart?: ReactNode
  actions?: ReactNode
}) => {
  const { t } = useLingui()
  const stripRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    stripRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [activeId, sessions.length])
  return (
    <div
      data-tauri-drag-region={isTauriDesktop() || undefined}
      data-browser-tab-strip
      className="flex shrink-0 items-center gap-2 border-b bg-muted/30 p-2"
      onDoubleClick={(event) => {
        if (event.target instanceof Element && !event.target.closest('button, [data-browser-tab]')) {
          onNewTab?.()
        }
      }}
    >
      {headerStart}
      <div
        data-tauri-drag-region={isTauriDesktop() || undefined}
        ref={stripRef}
        role="tablist"
        aria-label={t`Browser tabs`}
        className="flex min-w-0 flex-1 gap-2 overflow-x-auto"
        onKeyDown={(event) => {
          if (!(event.target instanceof HTMLElement) || event.target.getAttribute('role') !== 'tab') {
            return
          }
          const index = sessions.findIndex((session) => session.id === activeId)
          const next =
            event.key === 'ArrowRight'
              ? sessions[(index + 1) % sessions.length]
              : event.key === 'ArrowLeft'
                ? sessions[(index - 1 + sessions.length) % sessions.length]
                : event.key === 'Home'
                  ? sessions[0]
                  : event.key === 'End'
                    ? sessions.at(-1)
                    : undefined
          if (next) {
            event.preventDefault()
            onSelect(next.id)
            requestAnimationFrame(() =>
              stripRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus(),
            )
          } else if (event.key === 'Delete') {
            event.preventDefault()
            onClose(activeId)
          }
        }}
      >
        {sessions.map((session) => {
          const title =
            session.browser.url === 'about:blank'
              ? t`New tab`
              : session.browser.title || session.page.title || URL.parse(session.browser.url)?.hostname || t`Page`
          const selected = session.id === activeId
          return (
            <ContextMenu key={session.id}>
              <ContextMenuTrigger asChild>
                <div
                  data-browser-tab
                  role="presentation"
                  className={cn(
                    'group flex min-w-28 max-w-48 flex-1 items-center rounded-xl',
                    selected ? 'bg-background' : 'hover:bg-accent',
                  )}
                  onAuxClick={(event) => {
                    if (event.button === 1) {
                      event.preventDefault()
                      onClose(session.id)
                    }
                  }}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-controls={`browser-tab-panel-${session.id}`}
                    tabIndex={selected ? 0 : -1}
                    title={session.browser.url || session.page.title}
                    onClick={() => onSelect(session.id)}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-xl px-2 py-2 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    {session.browser.isLoading ? (
                      <LoaderCircle
                        aria-hidden="true"
                        className="size-3.5 shrink-0 animate-spin text-muted-foreground"
                      />
                    ) : (
                      <PageIcon
                        source={session.page.source}
                        url={session.browser.url}
                        icons={session.browser.faviconUrls}
                      />
                    )}
                    <span className="truncate">{title}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={t`Close tab ${title}`}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => onClose(session.id)}
                    className="mr-1 cursor-pointer rounded-xl p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X aria-hidden="true" className="size-3" />
                  </button>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem disabled={!canPinPage(session)} onSelect={() => onPin(session, 'browser')}>
                  <Pin />
                  <Trans>Pin</Trans>
                </ContextMenuItem>
                <ContextMenuItem disabled={!canPinPage(session)} onSelect={() => onPin(session, 'app')}>
                  <AppWindow />
                  <Trans>Pin as app</Trans>
                </ContextMenuItem>
                {pinnedIds.has(session.page.id) && (
                  <ContextMenuItem onSelect={() => onUnpin(session.page.id)}>
                    <PinOff />
                    <Trans>Unpin</Trans>
                  </ContextMenuItem>
                )}
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => onClose(session.id)}>
                  <X />
                  <Trans>Close tab</Trans>
                </ContextMenuItem>
                <ContextMenuItem onSelect={onCloseAll}>
                  <CopyX />
                  <Trans>Close all tabs</Trans>
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          )
        })}
        <div
          data-tauri-drag-region={isTauriDesktop() || undefined}
          data-browser-tab-empty
          aria-hidden="true"
          className="min-w-4 flex-1 self-stretch"
        />
      </div>
      <div data-browser-tab-actions className="flex shrink-0 items-center">
        {onNewTab && (
          <BrowserToolbarButton label={t`New tab`} onClick={onNewTab}>
            <Plus className="size-4" />
          </BrowserToolbarButton>
        )}
        {actions}
      </div>
    </div>
  )
}
