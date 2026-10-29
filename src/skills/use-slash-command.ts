/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useCallback, useMemo, useReducer, useRef, type KeyboardEvent, type RefObject } from 'react'

import type { Skill } from '@/types'
import type { AcpCommand } from '@/acp/translators/acp-to-ai-sdk'
import { chipMarker, findSkillTokens } from './parse-skill-tokens'
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

/** A picker opened by a swallowed `/` or `@`: the sigil is held here, not in the value. */
type Trigger = { start: number; sigil: string }

/** Put the swallowed sigil back into the value at the trigger start. */
const restoreSigil = (value: string, trigger: Trigger): string =>
  value.slice(0, trigger.start) + trigger.sigil + value.slice(trigger.start)

/** True while the caret stays inside the trigger's query (no whitespace in it). */
const caretInTrigger = (value: string, caret: number, trigger: Trigger): boolean =>
  caret >= trigger.start && !/\s/.test(value.slice(trigger.start, caret))

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

/** Slash state plus the number of sigil characters in the value before the query. */
type ActiveToken = SlashState & { sigilLength: 0 | 1 }

/** True at the start of the input or right after whitespace. */
const isTriggerBoundary = (value: string, caret: number): boolean => caret === 0 || /\s/.test(value[caret - 1] ?? '')

/** Resolve the token at the caret: a pending trigger first, else a sigil in the value. */
const resolveActiveToken = (value: string, cursor: number, trigger: Trigger | null): ActiveToken | null => {
  if (trigger && caretInTrigger(value, cursor, trigger)) {
    return { tokenStart: trigger.start, query: value.slice(trigger.start, cursor), sigilLength: 0 }
  }
  const state = getSlashState(value, cursor)
  return state && { ...state, sigilLength: 1 }
}

/** Swallow a `/` or `@` keypress that starts a token. Returns the trigger it opened, or null. */
const openTriggerFromKey = (e: KeyboardEvent<HTMLTextAreaElement>, value: string): Trigger | null => {
  if ((e.key !== '/' && e.key !== '@') || e.metaKey || e.ctrlKey || e.altKey) {
    return null
  }
  const { selectionStart, selectionEnd } = e.currentTarget
  if (selectionStart !== selectionEnd || !isTriggerBoundary(value, selectionStart)) {
    return null
  }
  e.preventDefault()
  return { start: selectionStart, sigil: e.key }
}

type SlashAction =
  | { type: 'OPEN_TRIGGER'; trigger: Trigger }
  | { type: 'CLEAR_TRIGGER' }
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
  trigger: Trigger | null
}

const initialState: SlashUiState = {
  cursorPos: 0,
  highlightedIdx: 0,
  closedForToken: null,
  trigger: null,
}

const reducer = (state: SlashUiState, action: SlashAction): SlashUiState => {
  switch (action.type) {
    case 'OPEN_TRIGGER':
      return { ...state, cursorPos: action.trigger.start, trigger: action.trigger, closedForToken: null }
    case 'CLEAR_TRIGGER':
      return state.trigger === null ? state : { ...state, trigger: null }
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
  const { cursorPos, highlightedIdx, closedForToken, trigger } = state
  // Synchronous copy for event handlers that run before the next render.
  const triggerRef = useRef<Trigger | null>(null)

  const slashState = useMemo(
    () => (enabled ? resolveActiveToken(value, cursorPos, trigger) : null),
    [enabled, value, cursorPos, trigger],
  )

  // Drop the trigger once the caret leaves it or whitespace ends it.
  if (trigger !== null && slashState?.sigilLength !== 0) {
    triggerRef.current = null
    dispatch({ type: 'CLEAR_TRIGGER' })
  }

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

  const insertToken = useCallback(
    (token: string) => {
      if (!slashState) {
        return
      }
      const tokenEnd = slashState.tokenStart + slashState.sigilLength + slashState.query.length
      const before = value.slice(0, slashState.tokenStart)
      const after = value.slice(tokenEnd)
      // Add a space only to keep following text from fusing with the token.
      const needsSpace = after.length > 0 && !/^\s/.test(after)
      const insert = needsSpace ? `${token} ` : token
      const next = before + insert + after
      const newCursor = slashState.tokenStart + insert.length
      // Update value and cursor in the same commit so the popup doesn't
      // flicker open on a stale-cursor render between setValue and rAF.
      triggerRef.current = null
      dispatch({ type: 'CLEAR_TRIGGER' })
      setValue(next)
      dispatch({ type: 'SET_CURSOR', pos: newCursor })
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.setSelectionRange(newCursor, newCursor)
      })
    },
    [slashState, value, setValue, inputRef],
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

  /** Write the swallowed sigil back into `live` and place the caret after it. */
  const foldTrigger = useCallback(
    (live: string, caret: number) => {
      const pending = triggerRef.current
      if (!pending) {
        return
      }
      triggerRef.current = null
      dispatch({ type: 'CLEAR_TRIGGER' })
      const pos = caret >= pending.start ? caret + 1 : caret
      setValue(restoreSigil(live, pending))
      dispatch({ type: 'SET_CURSOR', pos })
      requestAnimationFrame(() => inputRef.current?.setSelectionRange(pos, pos))
    },
    [setValue, inputRef],
  )

  /** Route a textarea edit; a trigger that can no longer match gets its sigil back. */
  const handleChange = useCallback(
    (next: string, caret: number) => {
      const pending = triggerRef.current
      const continues =
        pending && caretInTrigger(next, caret, pending) && itemsFor(next.slice(pending.start, caret)).length > 0
      if (pending && !continues) {
        foldTrigger(next, caret)
        return
      }
      setValue(next)
    },
    [itemsFor, foldTrigger, setValue],
  )

  /** Track the caret; leaving a pending trigger writes its sigil back. */
  const handleSelect = useCallback(
    (caret: number) => {
      const pending = triggerRef.current
      const live = inputRef.current?.value ?? value
      if (pending && !caretInTrigger(live, caret, pending)) {
        foldTrigger(live, caret)
        return
      }
      dispatch({ type: 'SET_CURSOR', pos: caret })
    },
    [inputRef, value, foldTrigger],
  )

  /** `value` with a pending trigger's sigil restored, for sending. */
  const valueWithTrigger = useMemo(() => (trigger ? restoreSigil(value, trigger) : value), [value, trigger])

  /** Insert the typed key after a space so it does not fuse with the chip before it. */
  const insertSpacedChar = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      e.preventDefault()
      const caret = e.currentTarget.selectionStart
      const pos = caret + 2
      setValue(`${value.slice(0, caret)} ${e.key}${value.slice(caret)}`)
      dispatch({ type: 'SET_CURSOR', pos })
      requestAnimationFrame(() => inputRef.current?.setSelectionRange(pos, pos))
    },
    [value, setValue, inputRef],
  )

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const opened = enabled && hasSuggestions ? openTriggerFromKey(e, value) : null
      if (opened) {
        triggerRef.current = opened
        dispatch({ type: 'OPEN_TRIGGER', trigger: opened })
        return
      }
      if (typedAgainstChip(e, value, displayNameToSlug)) {
        insertSpacedChar(e)
        return
      }
      if (!popupOpen) {
        return
      }
      if (e.key === 'Backspace' && slashState?.sigilLength === 0 && slashState.query === '') {
        // The sigil is not in the value, so cancel the trigger instead.
        e.preventDefault()
        triggerRef.current = null
        dispatch({ type: 'CLEAR_TRIGGER' })
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
        if (triggerRef.current) {
          foldTrigger(value, e.currentTarget.selectionStart)
        } else if (slashState) {
          dispatch({ type: 'DISMISS', tokenStart: slashState.tokenStart })
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
      foldTrigger,
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
    valueWithTrigger,
  }
}
