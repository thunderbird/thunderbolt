/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { LoaderCircle, Plus, X } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { BrowserToolbarButton } from './browser-toolbar-button'
import { BrowserFavicon } from './browser-favicon'
import type { BrowserTab } from './use-browser-tabs'

/** A scrollable tab strip that remains above the native page surface. */
export const BrowserTabStrip = ({
  tabs,
  activeId,
  visible,
  onSelect,
  onClose,
  onNewTab,
  actions,
}: {
  tabs: BrowserTab[]
  activeId: string
  visible: boolean
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNewTab: () => void
  actions?: ReactNode
}) => {
  const { t } = useLingui()
  const stripRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (visible) {
      stripRef.current
        ?.querySelector('[aria-selected="true"]')
        ?.closest('[data-browser-tab]')
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }, [activeId, visible, tabs.length])

  return (
    <div
      data-browser-tab-strip
      className="flex shrink-0 items-center gap-2 border-b bg-muted/30 p-2"
      onDoubleClick={(event) => {
        if (event.target instanceof Element && !event.target.closest('button, [data-browser-tab]')) {
          onNewTab()
        }
      }}
    >
      <div
        ref={stripRef}
        role="tablist"
        aria-label={t`Browser tabs`}
        className="flex min-w-0 flex-1 gap-2 overflow-x-auto"
        onKeyDown={(event) => {
          if (!(event.target instanceof HTMLElement) || event.target.getAttribute('role') !== 'tab') {
            return
          }
          const index = tabs.findIndex((tab) => tab.id === activeId)
          const target =
            event.key === 'ArrowRight'
              ? tabs[(index + 1) % tabs.length]
              : event.key === 'ArrowLeft'
                ? tabs[(index - 1 + tabs.length) % tabs.length]
                : event.key === 'Home'
                  ? tabs[0]
                  : event.key === 'End'
                    ? tabs.at(-1)
                    : undefined
          if (target) {
            event.preventDefault()
            onSelect(target.id)
            // The newly selected panel owns its own strip, so transfer keyboard
            // focus after React makes that panel visible.
            requestAnimationFrame(() => {
              document
                .getElementById(`browser-tab-panel-${target.id}`)
                ?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
                ?.focus()
            })
          } else if (event.key === 'Delete') {
            event.preventDefault()
            onClose(activeId)
          }
        }}
      >
        {tabs.map((tab) => {
          const title = tab.url === 'about:blank' ? t`New tab` : tab.title || new URL(tab.url).hostname
          const selected = tab.id === activeId
          return (
            <div
              key={tab.id}
              data-browser-tab
              role="presentation"
              className={cn(
                'group flex min-w-28 max-w-48 flex-1 items-center rounded-xl',
                selected ? 'bg-background' : 'hover:bg-accent',
              )}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault()
                  onClose(tab.id)
                }
              }}
            >
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`browser-tab-panel-${tab.id}`}
                tabIndex={selected ? 0 : -1}
                title={tab.url}
                onClick={() => onSelect(tab.id)}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-xl px-2 py-2 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                {tab.isLoading ? (
                  <LoaderCircle aria-hidden="true" className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                ) : (
                  <BrowserFavicon url={tab.url} icons={tab.faviconUrls} />
                )}
                <span className="truncate">{title}</span>
              </button>
              <button
                type="button"
                aria-label={t`Close tab ${title}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => onClose(tab.id)}
                className="mr-1 cursor-pointer rounded-xl p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X aria-hidden="true" className="size-3" />
              </button>
            </div>
          )
        })}
        <div data-browser-tab-empty aria-hidden="true" className="min-w-4 flex-1 self-stretch" />
      </div>
      <BrowserToolbarButton label={t`New tab`} onClick={onNewTab}>
        <Plus className="size-4" />
      </BrowserToolbarButton>
      {actions && <div className="flex shrink-0 items-center">{actions}</div>}
    </div>
  )
}
