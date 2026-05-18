/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useRef } from 'react'

import type { Skill } from './skills-data'

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

  useEffect(() => {
    const list = listRef.current
    if (!list) {
      return
    }
    const item = list.children[highlightedIdx] as HTMLElement | undefined
    item?.scrollIntoView({ block: 'nearest' })
  }, [highlightedIdx])

  return (
    <div className="absolute bottom-full left-0 z-50 mb-2 w-[360px] rounded-xl border border-border-strong bg-card px-2 py-3 shadow-md">
      <ul ref={listRef} className="max-h-[calc(3*(14px+3lh))] flex-col gap-0 overflow-y-auto">
        {skills.map((skill, idx) => (
          <li key={skill.name}>
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault()
                onSelect(skill)
              }}
              onMouseEnter={() => onHover(idx)}
              className={`flex w-full flex-col gap-0.5 rounded-xl px-2 py-1.5 text-left transition-colors ${
                idx === highlightedIdx ? 'bg-accent' : 'hover:bg-bg-hover'
              }`}
            >
              <span className="text-sm text-foreground">{skill.name}</span>
              <span className="line-clamp-2 min-h-[2lh] text-sm text-muted-foreground">{skill.description}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
