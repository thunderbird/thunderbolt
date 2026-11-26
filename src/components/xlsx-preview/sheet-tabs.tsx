/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import type { KeyboardEvent } from 'react'

type SheetTabsProps = {
  names: string[]
  selected: number
  onSelect: (index: number) => void
  /** The id of the panel the tabs control; each tab's id is this plus its index. */
  panelId: string
}

/** The tab a key moves focus to: the arrows wrap around, Home and End go to the ends. */
const tabAfter = (key: string, index: number, count: number) =>
  new Map([
    ['ArrowRight', (index + 1) % count],
    ['ArrowLeft', (index - 1 + count) % count],
    ['Home', 0],
    ['End', count - 1],
  ]).get(key)

/**
 * The sheet tabs under the grid, as in Excel. A tablist with one tab stop: the arrow keys, Home and End move focus
 * between tabs. Moving focus does not open a tab, because opening a large sheet takes a moment; Enter or Space does.
 * The tablist is written here because a tabs library would pull more shared code into the app's entry chunk.
 */
export const SheetTabs = ({ names, selected, onSelect, panelId }: SheetTabsProps) => {
  const { t } = useLingui()

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const tabs = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')]
    const focused = tabs.findIndex((tab) => tab === document.activeElement)
    const next = tabAfter(event.key, focused, tabs.length)
    if (next === undefined) {
      return
    }
    event.preventDefault()
    tabs[next]?.focus()
  }

  return (
    <div
      role="tablist"
      aria-label={t`Sheets`}
      onKeyDown={onKeyDown}
      className="flex shrink-0 overflow-x-auto border-t border-border bg-muted/50 px-1"
    >
      {names.map((name, index) => (
        <button
          key={index}
          type="button"
          role="tab"
          id={`${panelId}-tab-${index}`}
          aria-selected={index === selected}
          aria-controls={panelId}
          tabIndex={index === selected ? 0 : -1}
          onClick={() => onSelect(index)}
          className="-mt-px flex h-[var(--touch-height-sm)] shrink-0 cursor-pointer items-center whitespace-nowrap border-t-2 border-transparent px-3 text-[length:var(--font-size-sm)] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-selected:border-primary aria-selected:bg-white aria-selected:font-medium aria-selected:text-neutral-900"
        >
          {name}
        </button>
      ))}
    </div>
  )
}
