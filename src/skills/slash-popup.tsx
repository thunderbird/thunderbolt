/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Pin, PinOff } from 'lucide-react'
import { useEffect, useRef } from 'react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useIsMobile } from '@/hooks/use-mobile'
import type { Skill } from '@/types'

/**
 * Autocomplete dropdown for the slash command. Anchored above the chat
 * input (`bottom-full`) so it grows upward and never clips the keyboard on
 * mobile. Mouse-down (not click) selects so the textarea's blur handler
 * doesn't fire mid-selection.
 *
 * Each row carries a small pin toggle on the right. Pinning is managed
 * here (not in `/settings/skills`) per product direction, so the slash
 * popup is the canonical place to add a skill to the pinned chip bar.
 * The pin button intercepts pointer-down so toggling pin doesn't also
 * accept the row.
 */
export const SlashPopup = ({
  skills,
  highlightedIdx,
  isPinned,
  pinCapReached,
  onSelect,
  onHover,
  onTogglePin,
}: {
  skills: Skill[]
  highlightedIdx: number
  isPinned: (id: string) => boolean
  /**
   * `true` when the user already has the max number of pinned skills. The
   * pin button is disabled on unpinned rows so the user can't try to add
   * an over-cap pin and silently fail.
   */
  pinCapReached: boolean
  onSelect: (skill: Skill) => void
  onHover: (idx: number) => void
  onTogglePin: (skill: Skill) => void
}) => {
  const { isMobile } = useIsMobile()
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
      aria-label="Skills"
      className={`absolute bottom-full left-0 z-50 mb-2 rounded-xl border border-border bg-card p-1 shadow-lg ${
        isMobile ? 'right-0' : 'w-[360px]'
      }`}
    >
      <ul ref={listRef} className="max-h-64 overflow-y-auto">
        {skills.map((skill, idx) => {
          const pinned = isPinned(skill.id)
          const pinDisabled = !pinned && pinCapReached
          return (
            <li
              key={skill.id}
              className={`group flex items-center gap-1 rounded-md transition-colors ${
                idx === highlightedIdx ? 'bg-accent' : 'hover:bg-accent'
              }`}
            >
              <button
                type="button"
                role="option"
                aria-selected={idx === highlightedIdx}
                onMouseDown={(e) => {
                  e.preventDefault()
                  onSelect(skill)
                }}
                onMouseEnter={() => onHover(idx)}
                className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-left"
              >
                <span className="truncate text-[length:var(--font-size-body)] text-foreground">/{skill.name}</span>
                {skill.description && (
                  <span className="line-clamp-2 text-[length:var(--font-size-sm)] text-muted-foreground">
                    {skill.description}
                  </span>
                )}
              </button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={pinned ? `Unpin /${skill.name}` : `Pin /${skill.name}`}
                    aria-pressed={pinned}
                    disabled={pinDisabled}
                    onMouseDown={(e) => {
                      // Block the row's mousedown-select handler — we want to
                      // toggle pin without inserting the token. Don't focus
                      // either; the chat textarea should keep the caret.
                      e.preventDefault()
                      e.stopPropagation()
                    }}
                    onClick={(e) => {
                      e.stopPropagation()
                      onTogglePin(skill)
                    }}
                    className={`mr-1 inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground ${
                      pinned ? 'text-foreground' : ''
                    }`}
                  >
                    {pinned ? <PinOff size={14} /> : <Pin size={14} fill={pinned ? 'currentColor' : 'none'} />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  {pinDisabled ? 'Pinned limit reached' : pinned ? 'Unpin' : 'Pin for quick access'}
                </TooltipContent>
              </Tooltip>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
