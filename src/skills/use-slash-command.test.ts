/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import { act, renderHook } from '@testing-library/react'
import { createRef, type KeyboardEvent } from 'react'

import type { Skill } from '@/types'
import { getSlashState, useSlashCommand } from './use-slash-command'

const fakeSkill = (name: string): Skill => ({
  id: name,
  name,
  description: '',
  instruction: `instruction for ${name}`,
  enabled: 1,
  pinnedOrder: null,
  deletedAt: null,
  defaultHash: null,
  userId: null,
  workspaceId: null,
})

/** Build a partial KeyboardEvent that's just enough to satisfy the hook. */
const keyEvent = (key: string): KeyboardEvent<HTMLTextAreaElement> => {
  const e = { key, shiftKey: false, preventDefault: mock() }
  return e as unknown as KeyboardEvent<HTMLTextAreaElement>
}

describe('getSlashState', () => {
  it('returns null when the caret is outside the value bounds', () => {
    expect(getSlashState('hello', -1)).toBeNull()
    expect(getSlashState('hello', 6)).toBeNull()
  })

  it('returns null when there is no in-progress slash token', () => {
    expect(getSlashState('hello world', 5)).toBeNull()
    expect(getSlashState('', 0)).toBeNull()
  })

  it('detects a slash token at the start of the input', () => {
    expect(getSlashState('/meet', 5)).toEqual({ tokenStart: 0, query: 'meet' })
  })

  it('detects a slash token after a space', () => {
    expect(getSlashState('hello /meet', 11)).toEqual({ tokenStart: 6, query: 'meet' })
  })

  it('detects a slash token after a newline', () => {
    expect(getSlashState('line one\n/meet', 14)).toEqual({ tokenStart: 9, query: 'meet' })
  })

  it('treats a lone slash with no query as a token (empty query opens the full popup)', () => {
    expect(getSlashState('hello /', 7)).toEqual({ tokenStart: 6, query: '' })
  })

  it('returns null when the would-be token does not start with /', () => {
    // caret right after "world" — the preceding chunk is "world", not a slash token.
    expect(getSlashState('hello world', 11)).toBeNull()
  })

  it('returns null when the caret is mid-word after a space-prefixed identifier', () => {
    // " meet" — no leading slash, so no token.
    expect(getSlashState('hello meet', 10)).toBeNull()
  })

  it('honors the caret position when there is text after it', () => {
    // value = "hi /meet later"; caret at index 7 (just after "mee"), so the
    // in-progress query is "mee" — the trailing "t later" is not yet typed
    // from the autocomplete state machine's perspective.
    expect(getSlashState('hi /meet later', 7)).toEqual({ tokenStart: 3, query: 'mee' })
  })
})

describe('useSlashCommand handleKeyDown', () => {
  const library = [fakeSkill('alpha'), fakeSkill('beta')]
  const inputRef = createRef<HTMLTextAreaElement>()

  const setupOpen = () => {
    let value = '/al'
    const setValue = (v: string) => {
      value = v
    }
    const hook = renderHook(() =>
      useSlashCommand({
        value,
        setValue,
        inputRef,
        library,
        isEnabled: () => true,
      }),
    )
    // Caret right after "/al" so the popup opens with one match (alpha).
    act(() => hook.result.current.setCursorPos(3))
    return { hook, getValue: () => value }
  }

  it('Tab accepts the highlighted suggestion just like Enter', () => {
    const { hook, getValue } = setupOpen()
    expect(hook.result.current.popupOpen).toBe(true)
    const event = keyEvent('Tab')
    act(() => hook.result.current.handleKeyDown(event))
    expect(event.preventDefault).toHaveBeenCalled()
    // setValue was called with the canonical token + trailing space.
    expect(getValue()).toBe('/alpha ')
  })

  it('Enter accepts (regression — Tab path must not break Enter)', () => {
    const { hook, getValue } = setupOpen()
    const event = keyEvent('Enter')
    act(() => hook.result.current.handleKeyDown(event))
    expect(event.preventDefault).toHaveBeenCalled()
    expect(getValue()).toBe('/alpha ')
  })

  it('does nothing on non-accept keys', () => {
    const { hook, getValue } = setupOpen()
    const event = keyEvent('a')
    act(() => hook.result.current.handleKeyDown(event))
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(getValue()).toBe('/al')
  })
})

describe('useSlashCommand selectSkill', () => {
  const library = [fakeSkill('alpha')]
  const inputRef = createRef<HTMLTextAreaElement>()

  const setup = (initial: string, caret: number) => {
    let value = initial
    const setValue = (v: string) => {
      value = v
    }
    const hook = renderHook(() =>
      useSlashCommand({
        value,
        setValue,
        inputRef,
        library,
        isEnabled: () => true,
      }),
    )
    act(() => hook.result.current.setCursorPos(caret))
    return { hook, getValue: () => value }
  }

  it('does not insert a double space when the following text already starts with whitespace', () => {
    // caret right after "/al"; text after the token starts with " world".
    const { hook, getValue } = setup('/al world', 3)
    act(() => hook.result.current.selectSkill(fakeSkill('alpha')))
    expect(getValue()).toBe('/alpha world')
  })

  it('inserts a trailing space when there is no whitespace after the token', () => {
    const { hook, getValue } = setup('/al', 3)
    act(() => hook.result.current.selectSkill(fakeSkill('alpha')))
    expect(getValue()).toBe('/alpha ')
  })

  it('does not leave the popup open at the stale cursor after selection', () => {
    // Regression: previously SET_CURSOR was deferred to rAF, so the render
    // between setValue and the cursor update could re-detect a slash token at
    // the stale caret and flash popupOpen back to true.
    const { hook } = setup('/al', 3)
    expect(hook.result.current.popupOpen).toBe(true)
    act(() => hook.result.current.selectSkill(fakeSkill('alpha')))
    expect(hook.result.current.popupOpen).toBe(false)
  })
})

describe('useSlashCommand agent commands', () => {
  const inputRef = createRef<HTMLTextAreaElement>()

  const setup = (agentCommands: { name: string; description: string }[]) => {
    let value = '/'
    const setValue = (v: string) => {
      value = v
    }
    const hook = renderHook(() =>
      useSlashCommand({
        value,
        setValue,
        inputRef,
        library: [fakeSkill('alpha')],
        isEnabled: () => true,
        agentCommands,
      }),
    )
    act(() => hook.result.current.setCursorPos(1))
    return { hook, getValue: () => value }
  }

  it('lists agent commands as external items after the user skills', () => {
    const { hook } = setup([{ name: 'research_codebase', description: 'Explore the codebase' }])
    expect(hook.result.current.popupItems.map((i) => `${i.kind}:${i.name}`)).toEqual([
      'skill:alpha',
      'command:research_codebase',
    ])
  })

  it('selecting an agent command inserts its slash token', () => {
    const { hook, getValue } = setup([{ name: 'research_codebase', description: 'Explore the codebase' }])
    const command = hook.result.current.popupItems.find((i) => i.kind === 'command')
    expect(command).toBeDefined()
    act(() => hook.result.current.selectItem(command!))
    expect(getValue()).toBe('/research_codebase ')
  })

  it('drops an agent command that collides with a skill name (skill wins)', () => {
    const { hook } = setup([
      { name: 'alpha', description: 'agent alpha' },
      { name: 'research_codebase', description: 'Explore the codebase' },
    ])
    expect(hook.result.current.popupItems.map((i) => `${i.kind}:${i.name}`)).toEqual([
      'skill:alpha',
      'command:research_codebase',
    ])
  })
})
