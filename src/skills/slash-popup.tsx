/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useRef } from 'react'

import { useIsMobile } from '@/hooks/use-mobile'
import type { Skill } from '@/types'

/**
 * Autocomplete dropdown for the slash command. Anchored above the chat
 * input (`bottom-full`) so it grows upward and never clips the keyboard on
 * mobile. Mouse-down (not click) selects so the textarea's blur handler
 * doesn't fire mid-selection.
 */
export const SlashPopup = ({
  skills,
  highlightedIdx,
  onSelect,
  onHover,
}: {
  skills: Skill[]
  highlightedIdx: number
  onSelect: (skill: Skill) => void
  onHover: (idx: number) => void
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
        {skills.map((skill, idx) => (
          <li key={skill.id}>
            <button
              type="button"
              role="option"
              aria-selected={idx === highlightedIdx}
              onMouseDown={(e) => {
                e.preventDefault()
                onSelect(skill)
              }}
              onMouseEnter={() => onHover(idx)}
              className={`flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors ${
                idx === highlightedIdx ? 'bg-accent' : 'hover:bg-accent'
              }`}
            >
              <span className="text-[length:var(--font-size-body)] text-foreground">/{skill.name}</span>
              {skill.description && (
                <span className="line-clamp-2 text-[length:var(--font-size-sm)] text-muted-foreground">
                  {skill.description}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
