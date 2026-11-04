/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import { act, renderHook } from '@testing-library/react'
import { createRef, type KeyboardEvent } from 'react'

import type { Skill } from '@/types'
import { chipMarker, deleteSkillTokenAt, pendingSigilForKey } from './parse-skill-tokens'
import { getSlashState, useSlashCommand } from './use-slash-command'

const fakeSkill = (name: string, label: string | null = null): Skill => ({
  id: name,
  name,
  label,
  description: '',
  instruction: `instruction for ${name}`,
  enabled: 1,
  pinnedOrder: null,
  deletedAt: null,
  defaultHash: null,
  userId: null,
})

/** Build a partial KeyboardEvent that's just enough to satisfy the hook. */
const keyEvent = (key: string): KeyboardEvent<HTMLTextAreaElement> => {
  const e = { key, shiftKey: false, preventDefault: mock(), currentTarget: { selectionStart: 0, selectionEnd: 0 } }
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

  it('detects an @ token as an alternative trigger', () => {
    expect(getSlashState('hello @mee', 10)).toEqual({ tokenStart: 6, query: 'mee' })
    expect(getSlashState('@', 1)).toEqual({ tokenStart: 0, query: '' })
  })

  it('does not treat a mid-word @ (email address) as a trigger', () => {
    // The token starts at "foo…", not at the @ — so no trigger.
    expect(getSlashState('mail foo@example.com', 20)).toBeNull()
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
    // setValue was called with the display-title token + trailing space
    // (send-time normalization maps it back to the slug).
    expect(getValue()).toBe(`${chipMarker}Alpha`)
  })

  it('Enter accepts (regression — Tab path must not break Enter)', () => {
    const { hook, getValue } = setupOpen()
    const event = keyEvent('Enter')
    act(() => hook.result.current.handleKeyDown(event))
    expect(event.preventDefault).toHaveBeenCalled()
    expect(getValue()).toBe(`${chipMarker}Alpha`)
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

  it('leaves following whitespace as is', () => {
    // caret right after "/al"; text after the token starts with " world".
    const { hook, getValue } = setup('/al world', 3)
    act(() => hook.result.current.selectSkill(fakeSkill('alpha')))
    expect(getValue()).toBe(`${chipMarker}Alpha world`)
  })

  it('adds no space when the token ends the input', () => {
    const { hook, getValue } = setup('/al', 3)
    act(() => hook.result.current.selectSkill(fakeSkill('alpha')))
    expect(getValue()).toBe(`${chipMarker}Alpha`)
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

  it('selecting from an @-trigger inserts a chip token', () => {
    const { hook, getValue } = setup('@al', 3)
    expect(hook.result.current.popupOpen).toBe(true)
    act(() => hook.result.current.selectSkill(fakeSkill('alpha')))
    expect(getValue()).toBe(`${chipMarker}Alpha`)
  })
})

describe('useSlashCommand label search', () => {
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
        library: [fakeSkill('daily-brief', 'Daily Brief'), fakeSkill('unrelated', 'Something Else')],
        isEnabled: () => true,
      }),
    )
    act(() => hook.result.current.setCursorPos(caret))
    return { hook, getValue: () => value }
  }

  it('matches a substring of the display name, not just the slug prefix', () => {
    const { hook } = setup('/brief', 6)
    expect(hook.result.current.popupItems.map((i) => i.name)).toEqual(['daily-brief'])
  })

  it('exposes the display name as the item label', () => {
    const { hook } = setup('/daily', 6)
    expect(hook.result.current.popupItems[0]?.label).toBe('Daily Brief')
  })

  it('matches a label-less legacy skill by its title-cased display name', () => {
    // /meeting-notes has label null and displays as "Meeting Notes" — typing
    // "notes" must find it (regression: matching used the raw label column).
    let value = '/notes'
    const hook = renderHook(() =>
      useSlashCommand({
        value,
        setValue: (v: string) => {
          value = v
        },
        inputRef,
        library: [fakeSkill('meeting-notes'), fakeSkill('unrelated')],
        isEnabled: () => true,
      }),
    )
    act(() => hook.result.current.setCursorPos(6))
    expect(hook.result.current.popupItems.map((i) => i.name)).toEqual(['meeting-notes'])
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
    expect(getValue()).toBe('/research_codebase')
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

describe('useSlashCommand enabled option', () => {
  const library = [fakeSkill('alpha')]
  const inputRef = createRef<HTMLTextAreaElement>()

  it.each([
    [true, true],
    [false, false],
  ])('popup and keys follow the enabled option (%s)', (enabled, open) => {
    const setValue = mock()
    const hook = renderHook(() =>
      useSlashCommand({ value: '/', setValue, inputRef, library, isEnabled: () => true, enabled }),
    )
    act(() => hook.result.current.setCursorPos(1))
    expect(hook.result.current.popupOpen).toBe(open)
    const event = keyEvent('Enter')
    act(() => hook.result.current.handleKeyDown(event))
    expect(setValue.mock.calls.length > 0).toBe(open)
  })
})

describe('useSlashCommand pending sigil', () => {
  const library = [fakeSkill('alpha'), fakeSkill('beta')]
  const pendingSlash = pendingSigilForKey('/')!
  const pendingAt = pendingSigilForKey('@')!

  /** A keydown with the textarea selection the hook reads from `currentTarget`. */
  const keyAt = (key: string, caret: number, selectionEnd = caret) => {
    const e = { key, shiftKey: false, preventDefault: mock(), currentTarget: { selectionStart: caret, selectionEnd } }
    return e as unknown as KeyboardEvent<HTMLTextAreaElement>
  }

  /** Render the hook with a real textarea whose value follows every `setValue`. */
  const setup = (initial: string, skills = library) => {
    const textarea = document.createElement('textarea')
    textarea.value = initial
    const inputRef = createRef<HTMLTextAreaElement>() as { current: HTMLTextAreaElement | null }
    inputRef.current = textarea
    let value = initial
    const hook = renderHook(
      ({ v, enabled }: { v: string; enabled: boolean }) =>
        useSlashCommand({
          value: v,
          setValue: (next) => (value = next),
          inputRef,
          library: skills,
          isEnabled: () => true,
          enabled,
        }),
      { initialProps: { v: initial, enabled: true } },
    )
    const sync = () => hook.rerender({ v: value, enabled: true })
    const press = (key: string, caret: number, selectionEnd = caret) => {
      const event = keyAt(key, caret, selectionEnd)
      act(() => hook.result.current.handleKeyDown(event))
      sync()
      return event
    }
    const change = (next: string, caret: number) => {
      act(() => hook.result.current.handleChange(next, caret))
      // The textarea's select event follows every input event.
      act(() => hook.result.current.setCursorPos(caret))
      sync()
    }
    const select = (start: number, end = start) => {
      textarea.value = value
      act(() => hook.result.current.handleSelect(start, end))
      sync()
    }
    /** Replace the value from outside the hook, as `clearDraft` and `setInput` do. */
    const replaceFromOutside = (next: string) => {
      value = next
      sync()
    }
    return { hook, textarea, press, change, select, replaceFromOutside, getValue: () => value }
  }

  it.each([
    ['/', pendingSlash],
    ['@', pendingAt],
  ])('stores a zero-width stand-in for "%s" and opens the picker', (key, pending) => {
    const { hook, press, getValue } = setup('')
    const event = press(key, 0)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(getValue()).toBe(pending)
    expect(hook.result.current.popupOpen).toBe(true)
    expect(hook.result.current.popupItems).toHaveLength(2)
  })

  it('opens after whitespace', () => {
    const { hook, press, getValue } = setup('hello ')
    press('/', 6)
    expect(getValue()).toBe(`hello ${pendingSlash}`)
    expect(hook.result.current.popupOpen).toBe(true)
  })

  it('leaves a mid-word "/" as a literal character', () => {
    const { hook, press } = setup('and')
    const event = press('/', 3)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(hook.result.current.popupOpen).toBe(false)
  })

  it('leaves "/" literal when there is a selection range', () => {
    const { press } = setup('abc')
    expect(press('/', 0, 3).preventDefault).not.toHaveBeenCalled()
  })

  it('leaves "/" literal when nothing could be suggested', () => {
    const { press } = setup('', [])
    expect(press('/', 0).preventDefault).not.toHaveBeenCalled()
  })

  it('filters on the typed query and replaces the whole token on select', () => {
    const { hook, press, change, getValue } = setup('')
    press('/', 0)
    change(`${pendingSlash}al`, 3)
    expect(hook.result.current.popupItems.map((i) => i.name)).toEqual(['alpha'])
    press('Enter', 3)
    expect(getValue()).toBe(`${chipMarker}Alpha`)
  })

  it('keeps following text intact when selecting', () => {
    const { press, getValue } = setup('hi there')
    press('/', 3)
    press('Enter', 4)
    expect(getValue()).toBe(`hi ${chipMarker}Alpha there`)
  })

  it('writes the sigil back when whitespace ends the query', () => {
    const { hook, press, change, getValue } = setup('')
    press('/', 0)
    change(`${pendingSlash}al `, 4)
    expect(getValue()).toBe('/al ')
    expect(hook.result.current.popupOpen).toBe(false)
  })

  it('writes the sigil back when nothing matches the query', () => {
    const { press, change, getValue } = setup('')
    press('/', 0)
    change(`${pendingSlash}zz`, 3)
    expect(getValue()).toBe('/zz')
  })

  it('keeps the stand-in while a match remains', () => {
    const { press, change, getValue } = setup('')
    press('/', 0)
    change(`${pendingSlash}al`, 3)
    expect(getValue()).toBe(`${pendingSlash}al`)
  })

  it('writes "@" back as "@"', () => {
    const { press, change, getValue } = setup('ping ')
    press('@', 5)
    change(`ping ${pendingAt}zz`, 8)
    expect(getValue()).toBe('ping @zz')
  })

  describe('Escape', () => {
    it('restores the sigil and closes the picker with one press', () => {
      const { hook, press, change, getValue } = setup('')
      press('/', 0)
      change(`${pendingSlash}al`, 3)
      press('Escape', 3)
      expect(getValue()).toBe('/al')
      expect(hook.result.current.popupOpen).toBe(false)
    })

    it('restores a bare sigil and closes the picker', () => {
      const { hook, press, getValue } = setup('')
      press('/', 0)
      press('Escape', 1)
      expect(getValue()).toBe('/')
      expect(hook.result.current.popupOpen).toBe(false)
    })

    it('dismisses a literal token without changing the value', () => {
      const { hook, press, getValue } = setup('/al')
      act(() => hook.result.current.setCursorPos(3))
      press('Escape', 3)
      expect(getValue()).toBe('/al')
      expect(hook.result.current.popupOpen).toBe(false)
    })
  })

  describe('value replaced from outside the hook', () => {
    it('closes the picker when the draft clears on send', () => {
      const { hook, press, change, replaceFromOutside } = setup('hi ')
      press('/', 3)
      change(`hi ${pendingSlash}se`, 6)
      replaceFromOutside('')
      expect(hook.result.current.popupOpen).toBe(false)
    })

    it('does not add a sigil to the next message', () => {
      const { press, change, replaceFromOutside, getValue } = setup('hi ')
      press('/', 3)
      replaceFromOutside('')
      change('o', 1)
      change('ok', 2)
      expect(getValue()).toBe('ok')
    })
  })

  describe('Backspace', () => {
    it('is not intercepted, so it removes the stand-in natively', () => {
      const { hook, press, change, getValue } = setup('')
      press('/', 0)
      expect(press('Backspace', 1).preventDefault).not.toHaveBeenCalled()
      change('', 0)
      expect(getValue()).toBe('')
      expect(hook.result.current.popupOpen).toBe(false)
    })

    it('leaves a chip before the trigger alone', () => {
      const chip = `${chipMarker}Alpha `
      const { hook, press, change, getValue } = setup(chip)
      press('/', chip.length)
      expect(deleteSkillTokenAt(getValue(), chip.length + 1, new Map([['Alpha', 'alpha']]))).toBeNull()
      change(chip, chip.length)
      expect(getValue()).toBe(chip)
      expect(hook.result.current.popupOpen).toBe(false)
    })
  })

  describe('doubled sigils', () => {
    it.each([
      ['/', pendingSlash, '// TODO'],
      ['@', pendingAt, '@@alex'],
    ])('keeps both "%s" characters', (key, pending, typed) => {
      const { press, change, getValue } = setup('')
      press(key, 0)
      expect(press(key, 1).preventDefault).not.toHaveBeenCalled()
      change(`${pending}${typed.slice(1)}`, typed.length)
      expect(getValue()).toBe(typed)
    })
  })

  describe('selection', () => {
    it('keeps both selection ends when leaving the trigger', () => {
      const { press, change, textarea, select, getValue } = setup('hello ')
      press('/', 6)
      change(`hello ${pendingSlash}al`, 9)
      select(0, 9)
      expect(getValue()).toBe('hello /al')
      expect(textarea.selectionStart).toBe(0)
      expect(textarea.selectionEnd).toBe(9)
    })

    it('keeps the caret in place when the caret leaves the trigger', () => {
      const { press, change, textarea, select, getValue } = setup('hi ')
      press('/', 3)
      change(`hi ${pendingSlash}al`, 6)
      select(1)
      expect(getValue()).toBe('hi /al')
      expect(textarea.selectionStart).toBe(1)
      expect(textarea.selectionEnd).toBe(1)
    })

    it('leaves the stand-in while the caret stays in the query', () => {
      const { press, change, select, getValue } = setup('')
      press('/', 0)
      change(`${pendingSlash}al`, 3)
      select(2)
      expect(getValue()).toBe(`${pendingSlash}al`)
    })
  })

  it('writes the sigil back when slash commands turn off', () => {
    const { hook, press, getValue } = setup('')
    press('/', 0)
    hook.rerender({ v: getValue(), enabled: false })
    expect(hook.result.current.popupOpen).toBe(false)
    act(() => hook.result.current.handleSelect(1, 1))
    expect(getValue()).toBe('/')
  })

  it('does not reopen the picker after deleting a selected chip', () => {
    const { hook, press, replaceFromOutside } = setup('')
    press('/', 0)
    press('Enter', 1)
    replaceFromOutside('')
    act(() => hook.result.current.setCursorPos(0))
    expect(hook.result.current.popupOpen).toBe(false)
  })

  it('puts a space between a chip and a character typed right after it', () => {
    const { press, getValue } = setup(`${chipMarker}Alpha`)
    const event = press('h', 6)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(getValue()).toBe(`${chipMarker}Alpha h`)
  })

  it('leaves the caret after the character typed against a chip with no deferred write', () => {
    const { press, textarea } = setup(`${chipMarker}Alpha`)
    press('h', 6)
    expect(textarea.selectionStart).toBe(8)
  })
})
