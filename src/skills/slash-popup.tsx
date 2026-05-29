/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useRef } from 'react'

import type { Skill } from '@/types'

/**
 * Autocomplete dropdown for the slash command. Anchored above the chat
 * input (`bottom-full`) and stretches to the input's full width so the
 * suggestion rows have room for the description without truncating early.
 *
 * Mouse-down (not click) selects so the textarea's blur handler doesn't
 * fire mid-selection. Pinning is *not* exposed here — `ChatSkillsBar`'s
 * `+` popover is the canonical pin entry point.
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
      // `rounded-2xl` to match the ModeSelector + chip dropdown across the
      // chat screen. The row highlight below uses `rounded-xl` (one notch
      // tighter) so the bg-accent fill sits concentrically inside the
      // `p-1` padding — outer 16px radius minus 4px padding = 12px inner.
      className="absolute bottom-full left-0 right-0 z-50 mb-2 rounded-2xl border border-border bg-card p-1 shadow-lg"
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
              className={`flex w-full cursor-pointer flex-col gap-0.5 rounded-xl px-2 py-1.5 text-left transition-colors ${
                idx === highlightedIdx ? 'bg-accent' : 'hover:bg-accent'
              }`}
            >
              <span className="truncate text-[length:var(--font-size-body)] text-foreground">/{skill.name}</span>
              {skill.description && (
                <span className="line-clamp-1 text-[length:var(--font-size-sm)] text-muted-foreground">
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
