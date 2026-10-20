/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { controlVerdict, measureNative, parseHierarchy, parseInspectScreen, readyLine } from '../native-layout'

const fixture = (name: string) => readFileSync(join(import.meta.dir, '../fixtures/native', name), 'utf8')

test('the iOS name step reads the keyboard from the inputView node', () => {
  const measure = measureNative(parseHierarchy(fixture('hier-name-kb.json')), 'ios')
  expect(measure).toEqual({ keyboard: { left: 0, top: 611, right: 440, bottom: 956 } })
  expect(readyLine(measure)).toBe('[qa-layout] ready keyboard=[0,611][440,956]')
})

test('the welcome screen has no keyboard', () =>
  expect(readyLine(measureNative(parseHierarchy(fixture('hier-00-welcome.json')), 'ios'))).toBe(
    '[qa-layout] ready keyboard=none',
  ))

test('inspect_screen of a chat composer with the keyboard open gives the keyboard on the ready line', () =>
  expect(readyLine(measureNative(parseInspectScreen(fixture('inspect-chat-kb.json')), 'ios'))).toMatch(
    /^\[qa-layout\] ready keyboard=\[0,\d+\]\[440,956\]$/,
  ))

test('both formats give the same tree, without the frameless nodes, on the whole screen', () => {
  const hierarchy = JSON.stringify({
    attributes: { bounds: '[0,0][0,0]', accessibilityText: '', text: '', value: '', hintText: '', 'resource-id': '' },
    children: [
      {
        attributes: { bounds: '[0,0][440,956]', accessibilityText: 'Thunderbolt Dev', focused: 'false' },
        children: [
          {
            attributes: {
              bounds: '[24,178][416,222]',
              accessibilityText: '',
              text: 'Enter your name',
              value: 'Enter your name',
              hintText: 'Enter your name',
              'resource-id': '',
              focused: 'true',
            },
            children: [],
          },
          { attributes: { bounds: '[0,611][440,956]', 'resource-id': 'inputView', focused: 'false' }, children: [] },
        ],
      },
      {
        attributes: { bounds: '[0,0][0,0]' },
        children: [{ attributes: { bounds: '[312,25][334,39]', accessibilityText: 'Cellular', value: 'No signal' } }],
      },
    ],
  })
  const inspect = JSON.stringify({
    ui_schema: {
      platform: 'ios',
      defaults: {
        enabled: true,
        focused: false,
        selected: false,
        checked: false,
        txt: '',
        hint: '',
        rid: '',
        val: '',
        a11y: '',
      },
    },
    elements: [
      {
        b: '[0,0][440,956]',
        a11y: 'Thunderbolt Dev',
        c: [
          {
            b: '[24,178][416,222]',
            txt: 'Enter your name',
            val: 'Enter your name',
            hint: 'Enter your name',
            focused: true,
          },
          { b: '[0,611][440,956]', rid: 'inputView' },
        ],
      },
      { b: '[312,25][334,39]', a11y: 'Cellular', txt: 'No signal', val: 'No signal' },
    ],
  })
  const root = parseHierarchy(hierarchy)
  expect(parseInspectScreen(inspect)).toEqual(root)
  expect(root.bounds).toEqual({ left: 0, top: 0, right: 440, bottom: 956 })
  expect(root.children.map((node) => node.label)).toEqual(['Thunderbolt Dev', 'Cellular'])
  expect(parseHierarchy(fixture('hier-name-kb.json')).bounds).toEqual({ left: 0, top: 0, right: 440, bottom: 956 })
})

test('Android reads no keyboard from the tree yet', () =>
  expect(measureNative(parseHierarchy(fixture('hier-name-kb.json')), 'android').keyboard).toBeUndefined())

// The control run recorded on the iOS simulator: the Email field focused, the keyboard open, the cover pinned over it.
const control = { hierarchy: fixture('hier-control-cover.json'), log: fixture('control-cover.txt') }

test('the control passes when the keyboard is open and the probe covered the Email field', () => {
  const verdict = controlVerdict({ ...control, platform: 'ios' })
  expect(verdict.ok).toBe(true)
  expect(verdict.lines).toEqual([
    '[qa-layout] ready keyboard=[0,638][440,956]',
    '[qa-layout] covered textbox "Email"',
    '[qa-layout] focus-covered textbox "Email"',
  ])
})

test('the control fails on a build whose probe saw no cover, and says why', () => {
  const log = control.log
    .split('\n')
    .filter((line) => !line.includes('covered'))
    .join('\n')
  const verdict = controlVerdict({ ...control, log, platform: 'ios' })
  expect(verdict.ok).toBe(false)
  expect(verdict.lines.at(-1)).toBe('[qa-control] no focus-covered line for textbox "Email"')
})

test('the control fails on iOS without the keyboard, and on another field', () => {
  const closed = controlVerdict({ ...control, hierarchy: fixture('hier-00-welcome.json'), platform: 'ios' })
  expect(closed.ok).toBe(false)
  expect(closed.lines).toContain('[qa-control] the keyboard is not open')
  const other = control.log.replaceAll('textbox "Email"', 'textbox "Name"')
  expect(controlVerdict({ ...control, log: other, platform: 'ios' }).ok).toBe(false)
})

test('the control on Android needs only the probe line until the tree gives a keyboard', () =>
  expect(controlVerdict({ ...control, hierarchy: fixture('hier-00-welcome.json'), platform: 'android' }).ok).toBe(true))
