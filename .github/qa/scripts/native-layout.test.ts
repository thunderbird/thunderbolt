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
  expect(measure).toEqual({ keyboard: { left: 0, top: 611, right: 440, bottom: 956 }, problems: [] })
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

// The run 39373388149 control on the Android emulator: the Email field focused at [84,1131][1000,1281] and Gboard open.
// Its root and the root's only child have no bounds.
const androidControl = fixture('hier-android-control.json')
const emailAt = (bounds: string) => androidControl.replace('"bounds":"[84,1131][1000,1281]"', `"bounds":"${bounds}"`)
const keyboardRect = { left: 0, top: 1517, right: 1080, bottom: 2274 }

test("Android reads the keyboard from Gboard's keyboard_holder and reports no cover where the field sits above it", () =>
  expect(measureNative(parseHierarchy(androidControl), 'android')).toEqual({ keyboard: keyboardRect, problems: [] }))

test('Android reports the focused field behind the keyboard from an overlap of 4 on both axes', () => {
  // The field's bottom edge 4 units into the keyboard, then 3.
  expect(measureNative(parseHierarchy(emailAt('[84,1131][1000,1521]')), 'android').problems).toEqual([
    '[qa-layout] behind-keyboard textbox "Email"',
  ])
  expect(measureNative(parseHierarchy(emailAt('[84,1131][1000,1520]')), 'android').problems).toEqual([])
  expect(measureNative(parseHierarchy(emailAt('[84,1700][1000,1850]')), 'android').problems).toEqual([
    '[qa-layout] behind-keyboard textbox "Email"',
  ])
})

test("a focused box in the keyboard's own window, like Gboard's emoji search, is not the app's field", () => {
  type Node = { attributes: Record<string, string>; children?: Node[] }
  const nodes = (node: Node): Node[] => [node, ...(node.children ?? []).flatMap(nodes)]
  const tree: Node = JSON.parse(androidControl)
  const all = nodes(tree)
  const email = all.find((node) => node.attributes.hintText === 'Email')
  const holder = all.find((node) => node.attributes['resource-id']?.endsWith(':id/keyboard_holder'))
  if (!email || !holder) throw new Error('the fixture lost its Email field or its keyboard')
  // The search box takes the focus from the Email field.
  email.attributes.focused = 'false'
  holder.children = [{ attributes: { bounds: '[40,1540][1040,1640]', hintText: 'Search emoji', focused: 'true' } }]
  expect(measureNative(parseHierarchy(JSON.stringify(tree)), 'android').problems).toEqual([])
})

test('iOS leaves the keyboard cover to the probe, even with the focused field under the keyboard', () => {
  const nameUnderKeyboard = fixture('hier-name-kb.json').replace('[24,178][416,222]', '[24,700][416,744]')
  expect(measureNative(parseHierarchy(nameUnderKeyboard), 'ios').problems).toEqual([])
})

test('inspect_screen on Android, whose root has no bounds, gives the whole screen', () =>
  expect(parseInspectScreen(fixture('inspect-android-onboarding.json')).bounds).toEqual({
    left: 0,
    top: 0,
    right: 1080,
    bottom: 2400,
  }))

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

test('a log without a ready line is a dead stream, not a missing cover', () => {
  const log = control.log
    .split('\n')
    .filter((line) => !line.includes('] ready'))
    .join('\n')
  const verdict = controlVerdict({ ...control, log, platform: 'ios' })
  expect(verdict.ok).toBe(false)
  expect(verdict.lines.at(-1)).toBe('[qa-control] the layout probe never reported ready')
  expect(verdict.lines.join('\n')).not.toContain('no focus-covered line')
})

test('the control fails without the keyboard on either platform, and on another field', () => {
  for (const platform of ['ios', 'android'] as const) {
    const closed = controlVerdict({ ...control, hierarchy: fixture('hier-00-welcome.json'), platform })
    expect(closed.ok).toBe(false)
    expect(closed.lines).toContain('[qa-control] the keyboard is not open')
  }
  const other = control.log.replaceAll('textbox "Email"', 'textbox "Name"')
  expect(controlVerdict({ ...control, log: other, platform: 'ios' }).ok).toBe(false)
})

test('the Android control run of run 39373388149 passes, with the keyboard from the tree', () => {
  const verdict = controlVerdict({
    hierarchy: androidControl,
    log: fixture('control-cover-android.txt'),
    platform: 'android',
  })
  expect(verdict.ok).toBe(true)
  expect(verdict.lines).toEqual([
    '[qa-layout] ready keyboard=[0,1517][1080,2274]',
    '[qa-layout] covered textbox "Email"',
    '[qa-layout] focus-covered textbox "Email"',
  ])
})
