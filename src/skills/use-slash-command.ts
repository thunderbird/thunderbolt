/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useCallback, useMemo, useReducer, type KeyboardEvent, type RefObject } from 'react'

import type { Skill } from '@/types'
import type { AcpCommand } from '@/acp/translators/acp-to-ai-sdk'
import {
  chipMarker,
  findSkillTokens,
  foldPendingSigils,
  hasPendingSigil,
  isPendingSigil,
  pendingSigilForKey,
} from './parse-skill-tokens'
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
 * start with `/`, `@` or a pending sigil to be considered a trigger token;
 * otherwise we return `null`. Both triggers open the same skill picker; selecting a skill inserts
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
  if (!token.startsWith('/') && !token.startsWith('@') && !isPendingSigil(token[0])) {
    return null
  }
  // Which trigger opened the token is irrelevant downstream — selection
  // replaces the whole token range, so `@` naturally becomes `/`.
  return { tokenStart, query: token.slice(1) }
}

/** The query at the caret when a pending sigil opened its token, else null. */
const pendingQueryAt = (value: string, caret: number): string | null => {
  const state = getSlashState(value, caret)
  return state && isPendingSigil(value[state.tokenStart]) ? state.query : null
}

/** True for a printable, non-space key typed with a collapsed caret right after a chip. */
const typedAgainstChip = (
  e: KeyboardEvent<HTMLTextAreaElement>,
  value: string,
  displayNameToSlug: ReadonlyMap<string, string>,
): boolean => {
  if (e.key.length !== 1 || /\s/.test(e.key) || e.metaKey || e.ctrlKey || e.altKey) {
    return false
  }
  const { selectionStart, selectionEnd } = e.currentTarget
  if (selectionStart !== selectionEnd) {
    return false
  }
  return findSkillTokens(value, displayNameToSlug).some(
    (token) => token.end === selectionStart && value[token.start] === chipMarker,
  )
}

/** True at the start of the input or right after whitespace. */
const isTriggerBoundary = (value: string, caret: number): boolean => caret === 0 || /\s/.test(value[caret - 1] ?? '')

/** The pending sigil for a `/` or `@` keypress that starts a token, or null. */
const pendingSigilFromKey = (e: KeyboardEvent<HTMLTextAreaElement>, value: string): string | null => {
  if (e.metaKey || e.ctrlKey || e.altKey) {
    return null
  }
  const { selectionStart, selectionEnd } = e.currentTarget
  if (selectionStart !== selectionEnd || !isTriggerBoundary(value, selectionStart)) {
    return null
  }
  return pendingSigilForKey(e.key)
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
  enabled = true,
}: {
  value: string
  setValue: (v: string) => void
  inputRef: RefObject<HTMLTextAreaElement | null>
  library: Skill[]
  isEnabled: (slug: string) => boolean
  /** Commands advertised by the connected ACP agent, shown as external items. */
  agentCommands?: AcpCommand[]
  /** When false, `/` and `@` are ordinary text: no slash state, so the popup
   *  never opens and the key handler stays inert. */
  enabled?: boolean
}) => {
  const [state, dispatch] = useReducer(reducer, initialState)
  const { cursorPos, highlightedIdx, closedForToken } = state

  const slashState = useMemo(() => (enabled ? getSlashState(value, cursorPos) : null), [enabled, value, cursorPos])

  // User skills first, then the agent's external commands; each alphabetical,
  // both filtered by the in-progress query. Skills match anywhere in the
  // slug OR the display name, so searching "brief" finds "Daily Brief"
  // (/daily-brief) — and "notes" finds a label-less /meeting-notes displayed
  // as "Meeting Notes".
  const itemsFor = useCallback(
    (rawQuery: string): SlashItem[] => {
      // `skillMatchesQuery` lowercases internally; the lowered copy is only for
      // the agent-command comparisons below.
      const query = rawQuery.toLowerCase()
      const skillItems: SlashItem[] = library
        .filter((s) => isEnabled(s.name) && skillMatchesQuery(s, rawQuery))
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
    },
    [library, isEnabled, agentCommands],
  )
  const popupItems = useMemo(() => (slashState ? itemsFor(slashState.query) : []), [slashState, itemsFor])

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

  /** Write value and selection to the textarea in one step, so a select event never sees the caret React's commit moved. */
  const writeEdit = useCallback(
    (next: string, start: number, end: number = start) => {
      const textarea = inputRef.current
      if (textarea) {
        textarea.value = next
        textarea.setSelectionRange(start, end)
      }
      setValue(next)
      dispatch({ type: 'SET_CURSOR', pos: start })
    },
    [inputRef, setValue],
  )

  const insertToken = useCallback(
    (token: string) => {
      if (!slashState) {
        return
      }
      const tokenEnd = slashState.tokenStart + 1 + slashState.query.length
      const before = value.slice(0, slashState.tokenStart)
      const after = value.slice(tokenEnd)
      // Add a space only to keep following text from fusing with the token.
      const needsSpace = after.length > 0 && !/^\s/.test(after)
      const insert = needsSpace ? `${token} ` : token
      const next = before + insert + after
      const newCursor = slashState.tokenStart + insert.length
      writeEdit(next, newCursor)
      inputRef.current?.focus()
    },
    [slashState, value, writeEdit, inputRef],
  )

  const hasSuggestions = useMemo(
    () => agentCommands.length > 0 || library.some((s) => isEnabled(s.name)),
    [agentCommands, library, isEnabled],
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
    (item: SlashItem) => insertToken(item.kind === 'skill' ? chipMarker + skillToken(item.skill) : `/${item.name}`),
    [insertToken, skillToken],
  )
  /** Insert a skill's slash token. Convenience for the skill path (and tests). */
  const selectSkill = useCallback(
    (skill: Skill) => insertToken(chipMarker + skillToken(skill)),
    [insertToken, skillToken],
  )

  /** Route a textarea edit; a pending sigil that can no longer match becomes the typed character. */
  const handleChange = useCallback(
    (next: string, caret: number) => {
      const query = enabled ? pendingQueryAt(next, caret) : null
      if (hasPendingSigil(next) && (query === null || itemsFor(query).length === 0)) {
        writeEdit(foldPendingSigils(next), caret)
        return
      }
      setValue(next)
    },
    [enabled, itemsFor, writeEdit, setValue],
  )

  /** Track the caret; leaving a pending sigil turns it into the typed character. */
  const handleSelect = useCallback(
    (start: number, end: number) => {
      const live = inputRef.current?.value ?? value
      if (hasPendingSigil(live) && (!enabled || pendingQueryAt(live, start) === null)) {
        writeEdit(foldPendingSigils(live), start, end)
        return
      }
      dispatch({ type: 'SET_CURSOR', pos: start })
    },
    [enabled, inputRef, value, writeEdit],
  )

  /** Close the picker for the token at the caret; a pending sigil becomes the typed character. */
  const dismissToken = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>, tokenStart: number) => {
      if (isPendingSigil(value[tokenStart])) {
        writeEdit(foldPendingSigils(value), e.currentTarget.selectionStart, e.currentTarget.selectionEnd)
      }
      dispatch({ type: 'DISMISS', tokenStart })
    },
    [value, writeEdit],
  )

  /** Insert the typed key after a space so it does not fuse with the chip before it. */
  const insertSpacedChar = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      e.preventDefault()
      const caret = e.currentTarget.selectionStart
      writeEdit(`${value.slice(0, caret)} ${e.key}${value.slice(caret)}`, caret + 2)
    },
    [value, writeEdit],
  )

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const pendingSigil = enabled && hasSuggestions ? pendingSigilFromKey(e, value) : null
      if (pendingSigil) {
        e.preventDefault()
        const caret = e.currentTarget.selectionStart
        writeEdit(value.slice(0, caret) + pendingSigil + value.slice(caret), caret + 1)
        return
      }
      if (typedAgainstChip(e, value, displayNameToSlug)) {
        insertSpacedChar(e)
        return
      }
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
          dismissToken(e, slashState.tokenStart)
        }
      }
    },
    [
      enabled,
      hasSuggestions,
      value,
      popupOpen,
      popupItems,
      highlightedIdx,
      selectItem,
      slashState,
      displayNameToSlug,
      insertSpacedChar,
      writeEdit,
      dismissToken,
    ],
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
    handleChange,
    handleSelect,
  }
}
