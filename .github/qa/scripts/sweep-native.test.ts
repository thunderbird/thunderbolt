/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { nativeStatesFor } from './sweep'
import { probeLines, stateProblems, summarize, type StateResult } from './sweep-native'

describe('probeLines', () => {
  const log = [
    '2026-11-04 19:30:01.1 Thunderbolt Dev: CONSOLE LOG [qa-layout] ready',
    '2026-11-04 19:30:02.4 Thunderbolt Dev: CONSOLE ERROR [qa-layout] focus-covered textbox "Ask me anything…"',
    '2026-11-04 19:30:02.9 Thunderbolt Dev: CONSOLE ERROR [qa-layout] focus-covered textbox "Ask me anything…"',
    '2026-11-04 19:30:03.0 Thunderbolt Dev: CONSOLE ERROR [qa-layout] unnamed-control checkbox "after Name"',
    '2026-11-04 19:30:03.2 Thunderbolt Dev: CONSOLE ERROR [qa-layout] unnamed-control link "after Docs"',
    '2026-11-04 19:30:03.5 Thunderbolt Dev: CONSOLE LOG [init] step1_done',
  ].join('\n')

  test('keeps each problem once, without the ready line or other output', () =>
    expect(probeLines(log, 'android')).toEqual([
      '[qa-layout] focus-covered textbox "Ask me anything…"',
      '[qa-layout] unnamed-control link "after Docs"',
    ]))

  test("leaves the checkbox to iOS's tree too, which reports no link", () =>
    expect(probeLines(log, 'ios')).toEqual([
      '[qa-layout] focus-covered textbox "Ask me anything…"',
      '[qa-layout] unnamed-control link "after Docs"',
    ]))
})

describe('stateProblems', () => {
  // Recorded on the simulator: the sign-in name field with the keyboard up, and the welcome screen without it.
  const fixture = (name: string) => readFileSync(resolve(import.meta.dirname, '../fixtures/native', name), 'utf8')
  const withKeyboard = fixture('hier-name-kb.json')
  const ready = '... CONSOLE LOG [qa-layout] ready'

  test('a measured screen with nothing wrong has no problem', () =>
    expect(stateProblems({ log: ready, tree: withKeyboard, platform: 'ios', keyboard: true })).toEqual([]))

  test('fails a state whose measurement never ran, instead of passing it clean', () => {
    expect(stateProblems({ log: '', tree: withKeyboard, platform: 'ios', keyboard: false })).toEqual([
      '[qa-sweep] the layout probe never reported ready',
    ])
    expect(stateProblems({ log: ready, tree: undefined, platform: 'ios', keyboard: false })).toEqual([
      '[qa-sweep] maestro hierarchy failed',
    ])
  })

  test('fails a keyboard state whose keyboard never opened', () =>
    expect(
      stateProblems({ log: ready, tree: fixture('hier-00-welcome.json'), platform: 'ios', keyboard: true }),
    ).toEqual(['[qa-sweep] the keyboard is not open']))
})

describe('summarize', () => {
  const clean: StateResult = { state: 'sidebar', reached: true, problems: [], screenshot: 'matches' }

  test('passes a clean state, with or without a baseline', () =>
    expect(summarize([clean, { ...clean, state: 'sheet', screenshot: 'candidate' }]).ok).toBe(true))

  test.each([
    ['a layout problem', { ...clean, problems: ['[qa-layout] covered button "Send message"'] }],
    ['a baseline difference', { ...clean, screenshot: 'differs' as const }],
    ['a state it never reached', { ...clean, reached: false, screenshot: 'none' as const }],
    ['a screenshot it could not take', { ...clean, screenshot: 'none' as const }],
  ])('fails on %s', (_, result) => expect(summarize([clean, result]).ok).toBe(false))

  test('lists the problems of a state in its row', () =>
    expect(summarize([{ ...clean, problems: ['[qa-layout] offscreen button "Save"'] }]).lines[2]).toBe(
      '| sidebar | yes | `[qa-layout] offscreen button "Save"` | matches |',
    ))
})

describe('nativeStatesFor', () => {
  test('runs the large-text states on Android only, and the German one last', () => {
    expect(nativeStatesFor('ios').some((state) => 'large' in state)).toBe(false)
    expect(nativeStatesFor('android').filter((state) => 'large' in state)).toHaveLength(2)
    for (const platform of ['ios', 'android'] as const) {
      expect(nativeStatesFor(platform).at(-1)?.name).toBe('settings-de')
    }
  })
})
