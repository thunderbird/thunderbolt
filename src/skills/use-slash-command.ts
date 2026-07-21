/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useCallback, useMemo, useReducer, type KeyboardEvent, type RefObject } from 'react'

import type { Skill } from '@/types'
import type { AcpCommand } from '@/acp/translators/acp-to-ai-sdk'
import { buildDisplayNameToSlug, skillDisplayName, skillMatchesQuery, tokenForSkill } from './display'

/**
 * A selectable slash suggestion: a user-authored skill or an external command
 * advertised by the connected ACP agent (`kind: 'command'`).
 * `label` is the display name, which is what selecting a skill inserts
 * (`/Daily Brief`, normalized to the slug at send time); `name` is the slug.
 * Agent commands insert their literal `name`.
 */
export type SlashItem =
  | { kind: 'skill'; id: string; name: string; label: string; description: string; skill: Skill }
  | { kind: 'command'; id: string; name: string; label: string; description: string }

/** Position of the in-progress `/slug` (or `@slug`) token at the caret, or `null`. */
export type SlashState = { tokenStart: number; query: string }

/**
 * Detect whether the caret in `value` sits inside (or right after) a slash
 * token, and return the token's start offset + the query prefix typed so far.
 *
 * The token begins at the first character after the most recent whitespace
 * (space / tab / newline) before the caret, or at index 0 if none. It must
 * start with `/` or `@` to be considered a trigger token; otherwise we return
 * `null`. Both triggers open the same skill picker; selecting a skill inserts
 * its `/Display Title` token (normalized to the slug at send time), while
 * agent commands insert their literal `/name`. Mid-word `@` (e.g. an email
 * address) never matches because the token wouldn't *start* with the trigger.
 *
 * Note: the caller is expected to compare against the *current* caret
 * position, which is React-state-driven via {@link useSlashCommand}.
 */
export const getSlashState = (value: string, cursor: number): SlashState | null => {
  if (cursor < 0 || cursor > value.length) {
    return null
  }
  const before = value.slice(0, cursor)
  const lastWs = Math.max(before.lastIndexOf(' '), before.lastIndexOf('\n'), before.lastIndexOf('\t'))
  const tokenStart = lastWs + 1
  const token = value.slice(tokenStart, cursor)
  if (!token.startsWith('/') && !token.startsWith('@')) {
    return null
  }
  // Which trigger opened the token is irrelevant downstream — selection
  // replaces the whole token range, so `@` naturally becomes `/`.
  return { tokenStart, query: token.slice(1) }
}

type SlashAction =
  | { type: 'SET_CURSOR'; pos: number }
  | { type: 'SET_HIGHLIGHT'; idx: number }
  | { type: 'RESET_HIGHLIGHT' }
  | { type: 'DISMISS'; tokenStart: number }
  | { type: 'CLEAR_DISMISS' }

type SlashUiState = {
  cursorPos: number
  highlightedIdx: number
  /** Suppresses the popup for a specific token-start, so a re-render after
   * Esc doesn't reopen the same suggestion list until the user types more. */
  closedForToken: number | null
}

const initialState: SlashUiState = {
  cursorPos: 0,
  highlightedIdx: 0,
  closedForToken: null,
}

const reducer = (state: SlashUiState, action: SlashAction): SlashUiState => {
  switch (action.type) {
    case 'SET_CURSOR':
      return { ...state, cursorPos: action.pos }
    case 'SET_HIGHLIGHT':
      return { ...state, highlightedIdx: action.idx }
    case 'RESET_HIGHLIGHT':
      return state.highlightedIdx === 0 ? state : { ...state, highlightedIdx: 0 }
    case 'DISMISS':
      return { ...state, closedForToken: action.tokenStart }
    case 'CLEAR_DISMISS':
      return state.closedForToken === null ? state : { ...state, closedForToken: null }
  }
}

/**
 * Slash-autocomplete state machine for a textarea. Returns the suggested
 * skills (alphabetical, filtered by the in-progress query), the current
 * highlight, and a keyboard handler that drives ↑↓ navigation, Enter to
 * select, and Esc to dismiss.
 *
 * Recency / popularity ranking is intentionally out — Skills v1 §4 says the
 * popup is alphabetical-only, filtered by query.
 */
export const useSlashCommand = ({
  value,
  setValue,
  inputRef,
  library,
  isEnabled,
  agentCommands = [],
}: {
  value: string
  setValue: (v: string) => void
  inputRef: RefObject<HTMLTextAreaElement | null>
  library: Skill[]
  isEnabled: (slug: string) => boolean
  /** Commands advertised by the connected ACP agent, shown as external items. */
  agentCommands?: AcpCommand[]
}) => {
  const [state, dispatch] = useReducer(reducer, initialState)
  const { cursorPos, highlightedIdx, closedForToken } = state

  const slashState = useMemo(() => getSlashState(value, cursorPos), [value, cursorPos])

  // User skills first, then the agent's external commands; each alphabetical,
  // both filtered by the in-progress query. Skills match anywhere in the
  // slug OR the display name, so searching "brief" finds "Daily Brief"
  // (/daily-brief) — and "notes" finds a label-less /meeting-notes displayed
  // as "Meeting Notes".
  const popupItems = useMemo<SlashItem[]>(() => {
    if (!slashState) {
      return []
    }
    // `skillMatchesQuery` lowercases internally; the lowered copy is only for
    // the agent-command comparisons below.
    const query = slashState.query.toLowerCase()
    const skillItems: SlashItem[] = library
      .filter((s) => isEnabled(s.name) && skillMatchesQuery(s, slashState.query))
      // Slug tiebreak keeps ordering deterministic when two skills share a
      // display name (labels are free text).
      .sort((a, b) => skillDisplayName(a).localeCompare(skillDisplayName(b)) || a.name.localeCompare(b.name))
      .map((s) => ({
        kind: 'skill',
        id: s.id,
        name: s.name,
        label: skillDisplayName(s),
        description: s.description,
        skill: s,
      }))
    // A skill and an agent command can share a name; the skill wins so the
    // menu doesn't show two identical `/foo` rows.
    const skillNames = new Set(skillItems.map((s) => s.name.toLowerCase()))
    const commandItems: SlashItem[] = [...agentCommands]
      .filter((c) => c.name.toLowerCase().includes(query) && !skillNames.has(c.name.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({
        kind: 'command',
        id: `command:${c.name}`,
        name: c.name,
        label: c.name,
        description: c.description,
      }))
    return [...skillItems, ...commandItems]
  }, [slashState, library, isEnabled, agentCommands])

  const popupOpen = slashState !== null && popupItems.length > 0 && closedForToken !== slashState.tokenStart

  // Reset the highlight index when the slash token changes (different
  // start position OR different query string). Derived from render-time
  // state, no effect — see CLAUDE.md "useEffect Discipline".
  const tokenKey = slashState ? `${slashState.tokenStart}:${slashState.query}` : null
  const [prevTokenKey, setPrevTokenKey] = useReducer((_: string | null, next: string | null) => next, tokenKey)
  if (prevTokenKey !== tokenKey) {
    setPrevTokenKey(tokenKey)
    dispatch({ type: 'RESET_HIGHLIGHT' })
  }

  // Clear the dismissal when the caret leaves the token that was dismissed.
  if (closedForToken !== null && (!slashState || slashState.tokenStart !== closedForToken)) {
    dispatch({ type: 'CLEAR_DISMISS' })
  }

  const insertToken = useCallback(
    (name: string) => {
      if (!slashState) {
        return
      }
      const tokenEnd = slashState.tokenStart + 1 + slashState.query.length
      const before = value.slice(0, slashState.tokenStart)
      const after = value.slice(tokenEnd)
      // Skip the trailing space when the following text already starts with
      // whitespace — otherwise the user sees a doubled space after completion.
      const needsTrailingSpace = !/^\s/.test(after)
      const insert = `/${name}${needsTrailingSpace ? ' ' : ''}`
      const next = before + insert + after
      const newCursor = slashState.tokenStart + insert.length + (needsTrailingSpace ? 0 : 1)
      // Update value and cursor in the same commit so the popup doesn't
      // flicker open on a stale-cursor render between setValue and rAF.
      setValue(next)
      dispatch({ type: 'SET_CURSOR', pos: newCursor })
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.setSelectionRange(newCursor, newCursor)
      })
    },
    [slashState, value, setValue, inputRef],
  )

  const displayNameToSlug = useMemo(() => buildDisplayNameToSlug(library), [library])
  const skillToken = useCallback(
    (skill: Pick<Skill, 'name' | 'label'>) => tokenForSkill(skill, displayNameToSlug),
    [displayNameToSlug],
  )

  // Skills insert their display title (`/Daily Brief`) — the user never sees
  // the slug in chat; send-time normalization maps it back for the model.
  // Agent commands insert their literal name, which IS what the agent expects.
  const selectItem = useCallback(
    (item: SlashItem) => insertToken(item.kind === 'skill' ? skillToken(item.skill) : item.name),
    [insertToken, skillToken],
  )
  /** Insert a skill's slash token. Convenience for the skill path (and tests). */
  const selectSkill = useCallback((skill: Skill) => insertToken(skillToken(skill)), [insertToken, skillToken])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (!popupOpen) {
        return
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault()
        const picked = popupItems[highlightedIdx]
        if (picked) {
          selectItem(picked)
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        dispatch({ type: 'SET_HIGHLIGHT', idx: Math.min(highlightedIdx + 1, popupItems.length - 1) })
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        dispatch({ type: 'SET_HIGHLIGHT', idx: Math.max(highlightedIdx - 1, 0) })
      } else if (e.key === 'Escape') {
        e.preventDefault()
        if (slashState) {
          dispatch({ type: 'DISMISS', tokenStart: slashState.tokenStart })
        }
      }
    },
    [popupOpen, popupItems, highlightedIdx, selectItem, slashState],
  )

  const setCursorPos = useCallback((pos: number) => dispatch({ type: 'SET_CURSOR', pos }), [])
  const setHighlightedIdx = useCallback((idx: number) => dispatch({ type: 'SET_HIGHLIGHT', idx }), [])

  return {
    setCursorPos,
    popupItems,
    popupOpen,
    highlightedIdx,
    setHighlightedIdx,
    selectItem,
    selectSkill,
    handleKeyDown,
  }
}
