/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useRef } from 'react'

import type { SlashItem } from './use-slash-command'

/**
 * Autocomplete dropdown for the slash command. Anchored above the chat
 * input (`bottom-full`) and stretches to the input's full width so the
 * suggestion rows have room for the description without truncating early.
 *
 * Items are user skills plus any commands advertised by the connected ACP
 * agent — the latter carry a badge naming the agent they come from (e.g.
 * "Hermes") so it's clear they're the agent's commands, not the user's own
 * skill library.
 *
 * Mouse-down (not click) selects so the textarea's blur handler doesn't
 * fire mid-selection. Pinning is *not* exposed here — `ChatSkillsBar`'s
 * `+` popover is the canonical pin entry point.
 */
export const SlashPopup = ({
  items,
  agentName,
  highlightedIdx,
  onSelect,
  onHover,
}: {
  items: SlashItem[]
  /** Name of the connected ACP agent, used as the badge label on its commands. */
  agentName: string
  highlightedIdx: number
  onSelect: (item: SlashItem) => void
  onHover: (idx: number) => void
}) => {
  const listRef = useRef<HTMLUListElement>(null)

  // Scroll the highlighted row into view when the user arrow-keys past the
  // visible window. Legitimate effect — DOM measurement / scroll cannot be
  // expressed in render.
  useEffect(() => {
    const item = listRef.current?.children[highlightedIdx] as HTMLElement | undefined
    item?.scrollIntoView({ block: 'nearest' })
  }, [highlightedIdx])

  return (
    <div
      role="listbox"
      aria-label="Slash commands"
      // `rounded-xl` (container tier) to match the ModeSelector + chip dropdown
      // across the chat screen. The row highlight below uses `rounded-lg` (one
      // notch tighter) so the bg-accent fill sits concentrically inside the
      // `p-1` padding — outer 12px radius minus 4px padding = 8px inner.
      className="absolute bottom-full left-0 right-0 z-50 mb-2 rounded-xl border border-border bg-card p-1 shadow-lg"
    >
      <ul ref={listRef} className="max-h-64 overflow-y-auto">
        {items.map((item, idx) => (
          <li key={item.id}>
            <button
              type="button"
              role="option"
              aria-selected={idx === highlightedIdx}
              onMouseDown={(e) => {
                e.preventDefault()
                onSelect(item)
              }}
              onMouseEnter={() => onHover(idx)}
              className={`flex w-full cursor-pointer flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left transition-colors ${
                idx === highlightedIdx ? 'bg-accent' : 'hover:bg-accent'
              }`}
            >
              <span className="flex items-center gap-1.5">
                <span className="truncate text-[length:var(--font-size-body)] text-foreground">
                  {item.kind === 'command' ? `/${item.name}` : item.label}
                </span>
                {item.kind === 'command' && (
                  <span className="max-w-[10rem] shrink-0 truncate rounded-sm border border-border px-1 py-px text-[length:var(--font-size-xs)] text-muted-foreground">
                    {agentName}
                  </span>
                )}
              </span>
              {item.description && (
                <span className="line-clamp-1 text-[length:var(--font-size-sm)] text-muted-foreground">
                  {item.description}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
