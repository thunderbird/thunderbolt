/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useMemo, useState, type KeyboardEvent, type RefObject } from 'react'

import type { Skill } from './skills-data'

export type SlashState = { tokenStart: number; query: string }

export const getSlashState = (value: string, cursor: number): SlashState | null => {
  if (cursor < 0 || cursor > value.length) {
    return null
  }
  const before = value.slice(0, cursor)
  const lastWs = Math.max(before.lastIndexOf(' '), before.lastIndexOf('\n'), before.lastIndexOf('\t'))
  const tokenStart = lastWs + 1
  const token = value.slice(tokenStart, cursor)
  if (!token.startsWith('/')) {
    return null
  }
  return { tokenStart, query: token.slice(1) }
}

export const useSlashCommand = ({
  value,
  setValue,
  inputRef,
  library,
  isEnabled,
  recent,
  recordUsed,
}: {
  value: string
  setValue: (v: string) => void
  inputRef: RefObject<HTMLTextAreaElement | null>
  library: Skill[]
  isEnabled: (name: string) => boolean
  recent: string[]
  recordUsed: (name: string) => void
}) => {
  const [cursorPos, setCursorPos] = useState(0)
  const [highlightedIdx, setHighlightedIdx] = useState(0)
  const [closedForToken, setClosedForToken] = useState<number | null>(null)

  const slashState = useMemo(() => getSlashState(value, cursorPos), [value, cursorPos])

  const popupSkills = useMemo(() => {
    if (!slashState) {
      return []
    }
    const enabled = library.filter((s) => isEnabled(s.name))
    const query = slashState.query.toLowerCase()
    if (query === '') {
      const recentSet = new Set(recent)
      const recentSorted = recent
        .map((name) => enabled.find((s) => s.name === name))
        .filter((s): s is Skill => s !== undefined)
      const rest = enabled.filter((s) => !recentSet.has(s.name)).sort((a, b) => a.name.localeCompare(b.name))
      return [...recentSorted, ...rest]
    }
    return enabled
      .filter((s) => s.name.toLowerCase().slice(1).startsWith(query))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [slashState, library, isEnabled, recent])

  const popupOpen = slashState !== null && popupSkills.length > 0 && closedForToken !== slashState.tokenStart

  const tokenKey = slashState ? `${slashState.tokenStart}:${slashState.query}` : null
  const [prevTokenKey, setPrevTokenKey] = useState(tokenKey)
  if (prevTokenKey !== tokenKey) {
    setPrevTokenKey(tokenKey)
    setHighlightedIdx(0)
  }

  if (closedForToken !== null && (!slashState || slashState.tokenStart !== closedForToken)) {
    setClosedForToken(null)
  }

  const selectSkill = (skill: Skill) => {
    if (!slashState) {
      return
    }
    const tokenEnd = slashState.tokenStart + 1 + slashState.query.length
    const before = value.slice(0, slashState.tokenStart)
    const after = value.slice(tokenEnd)
    const insert = `${skill.name} `
    const next = before + insert + after
    setValue(next)
    recordUsed(skill.name)
    const newCursor = slashState.tokenStart + insert.length
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(newCursor, newCursor)
      setCursorPos(newCursor)
    })
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!popupOpen) {
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      const picked = popupSkills[highlightedIdx]
      if (picked) {
        selectSkill(picked)
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightedIdx((i) => Math.min(i + 1, popupSkills.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightedIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (slashState) {
        setClosedForToken(slashState.tokenStart)
      }
    }
  }

  return {
    setCursorPos,
    popupSkills,
    popupOpen,
    highlightedIdx,
    setHighlightedIdx,
    selectSkill,
    handleKeyDown,
  }
}
