/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  controlVerdict,
  keepsProbeLine,
  measureNative,
  type NativeNode,
  parseHierarchy,
  parseInspectScreen,
  readyLine,
} from '../native-layout'
import { fingerprint } from './findings'

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

type Dumped = { attributes: Record<string, string>; children?: Dumped[] }

/** A recorded `maestro hierarchy` with `change` applied to every node `pick` matches. */
const edited = (
  name: string,
  pick: (attributes: Record<string, string>) => boolean,
  change: Record<string, string>,
) => {
  const tree: Dumped = JSON.parse(fixture(name))
  const nodes = (node: Dumped): Dumped[] => [node, ...(node.children ?? []).flatMap(nodes)]
  const picked = nodes(tree).filter((node) => pick(node.attributes))
  if (picked.length === 0) throw new Error(`${name} has no node to change`)
  for (const node of picked) Object.assign(node.attributes, change)
  return JSON.stringify(tree)
}

// The iOS onboarding privacy step, recorded on the simulator: the checkbox is a leaf whose value is its state, 0.
const consentCheckbox = (attributes: Record<string, string>) => attributes.bounds === '[25,712][51,738]'

test('the iOS privacy checkbox reads its label, so the tree reports no unnamed control there', () =>
  expect(measureNative(parseHierarchy(fixture('hier-consent.json')), 'ios').problems).toEqual([]))

test('an iOS checkbox without a label is an unnamed control, even with its state as text', () => {
  const unnamed = edited('hier-consent.json', consentCheckbox, { accessibilityText: '' })
  expect(measureNative(parseHierarchy(unnamed), 'ios').problems).toEqual([
    '[qa-layout] unnamed-control checkbox "after Data is stored securely on your device."',
  ])
  // A placeholder names it, as on the web.
  const hinted = edited('hier-consent.json', consentCheckbox, { accessibilityText: '', hintText: 'Agree' })
  expect(measureNative(parseHierarchy(hinted), 'ios').problems).toEqual([])
})

test('a key of the iOS keyboard is never an unnamed control', () => {
  // The shift key with no label and the value of a pressed toggle, which anywhere else reads as a checkbox.
  const shift = (attributes: Record<string, string>) => attributes['resource-id'] === 'shift'
  const bare = { accessibilityText: '', value: '1', text: '1' }
  expect(measureNative(parseHierarchy(edited('hier-name-kb.json', shift, bare)), 'ios').problems).toEqual([])
  const moved = edited('hier-name-kb.json', shift, { ...bare, bounds: '[4,300][60,356]' })
  expect(measureNative(parseHierarchy(moved), 'ios').problems).toEqual([
    '[qa-layout] unnamed-control checkbox "#shift"',
  ])
})

test('an Android control with no description, text or hint is unnamed, quoted by the text before it', () => {
  const noHint = (attributes: Record<string, string>) =>
    attributes.class === 'android.widget.EditText' || attributes.class === 'android.widget.Button'
  const unnamed = edited('hier-android-control.json', noHint, { hintText: '', text: '' })
  expect(measureNative(parseHierarchy(unnamed), 'android').problems).toEqual([
    '[qa-layout] unnamed-control textbox "after Thunderbolt"',
    '[qa-layout] unnamed-control button "after Language"',
  ])
  // Two fields with no text between them quote the same place, so they are one line.
  const fields = (attributes: Record<string, string>) =>
    attributes.class === 'android.widget.EditText' || attributes.class === 'android.widget.Spinner'
  const twoFields = parseHierarchy(
    edited('hier-android-control.json', fields, { class: 'android.widget.EditText', text: '', hintText: '' }),
  )
  const nodes = (node: NativeNode): NativeNode[] => [node, ...node.children.flatMap(nodes)]
  expect(nodes(twoFields).filter((node) => node.role === 'textbox' && !node.name)).toHaveLength(2)
  expect(measureNative(twoFields, 'android').problems).toEqual([
    '[qa-layout] unnamed-control textbox "after Thunderbolt"',
  ])
})

test("an Android field's own text is its value, never its name", () => {
  const typed = edited('hier-android-control.json', (attributes) => attributes.hintText === 'Email', {
    hintText: '',
    text: 'qa@thunderbolt.test',
  })
  expect(measureNative(parseHierarchy(typed), 'android').problems).toEqual([
    '[qa-layout] unnamed-control textbox "after Thunderbolt"',
  ])
  // The language picker shows the selected language as its text.
  const picked = edited('hier-android-control.json', (attributes) => attributes.hintText === 'Language', {
    hintText: '',
  })
  expect(measureNative(parseHierarchy(picked), 'android').problems).toEqual([
    '[qa-layout] unnamed-control combobox "after Email"',
  ])
})

test('an iOS heading, whose value is its level, is no checkbox even at level 1 with no label', () => {
  const welcome = (attributes: Record<string, string>) =>
    attributes.accessibilityText === 'Welcome to Thunderbolt!' && attributes.value === '2'
  const heading = edited('hier-consent.json', welcome, { accessibilityText: '', value: '1', text: '1' })
  expect(measureNative(parseHierarchy(heading), 'ios').problems).toEqual([])
})

test('on Android a window over the app, like a browser tab, is not the app', () => {
  const tree: Dumped = JSON.parse(androidControl)
  const windows = tree.children?.[0]?.children
  if (!windows) throw new Error('the fixture lost its windows')
  windows.push({
    attributes: {
      bounds: '[0,136][1080,2400]',
      class: 'android.widget.FrameLayout',
      'resource-id': 'com.android.chrome:id/tab',
    },
    children: [{ attributes: { bounds: '[40,300][200,400]', class: 'android.widget.Button' } }],
  })
  expect(measureNative(parseHierarchy(JSON.stringify(tree)), 'android').problems).toEqual([])
})

type Inspected = { b?: string; txt?: string; rid?: string; cls?: string; c?: Inspected[] }

/** The tree's lines for the recorded Android Connect Google step, with `change` run on every element first. */
const onboardingLines = (change: (element: Inspected) => void = () => {}) => {
  const screen: { elements: Inspected[] } = JSON.parse(fixture('inspect-android-onboarding.json'))
  const elements = (element: Inspected): Inspected[] => [element, ...(element.c ?? []).flatMap(elements)]
  for (const element of screen.elements.flatMap(elements)) change(element)
  return measureNative(parseInspectScreen(JSON.stringify(screen)), 'android').problems
}

const isBack = (element: Inspected) => element.cls === 'android.widget.Button' && element.txt === undefined

/** The fingerprint filing gives an onboarding `layout` finding that quotes `line`. */
const fingerprintOf = (line: string) =>
  fingerprint({
    title: 'An unnamed control',
    area: 'onboarding',
    charter: 'c1-first-run',
    viewport: 'android',
    oracle: { type: 'layout', evidence: line },
    steps: ['Open the step'],
    expected: 'A screen reader names the control',
    actual: 'It has no name',
    repro_flow: 'repro/1.yaml',
  })

test('the Android Connect Google step reports its icon-only Back button, the one button there without a name', () =>
  expect(onboardingLines()).toEqual(['[qa-layout] unnamed-control button "after Connect Google"']))

test('two unnamed buttons on one screen are two lines with two fingerprints', () => {
  const lines = onboardingLines((element) => {
    if (element.txt === 'Continue') element.txt = ''
  })
  expect(lines).toEqual([
    '[qa-layout] unnamed-control button "after Connect Google"',
    '[qa-layout] unnamed-control button "after Skip"',
  ])
  expect(new Set(lines.map(fingerprintOf)).size).toBe(2)
})

test('the same control in another run, with new generated ids and other bounds, has the same fingerprint', () => {
  const again = onboardingLines((element) => {
    if (element.b) element.b = element.b.replace(/\d+/g, (n) => String(Number(n) + 7))
    if (element.rid?.startsWith('radix-')) element.rid = 'radix-_r_1f_'
    if (isBack(element)) element.rid = 'radix-_r_2_'
  })
  expect(again.map(fingerprintOf)).toEqual(onboardingLines().map(fingerprintOf))
})

test('a page id names the control, as the probe does', () =>
  expect(
    onboardingLines((element) => {
      if (isBack(element)) element.rid = 'onboarding-back'
    }),
  ).toEqual(['[qa-layout] unnamed-control button "#onboarding-back"']))

test("an unnamed button in Gboard's keys is not the app's", () => {
  const holder = (attributes: Record<string, string>) => attributes['resource-id']?.endsWith(':id/keyboard_holder')
  const tree: Dumped = JSON.parse(androidControl)
  const nodes = (node: Dumped): Dumped[] => [node, ...(node.children ?? []).flatMap(nodes)]
  const keys = nodes(tree).find((node) => holder(node.attributes))
  if (!keys) throw new Error('the fixture lost its keyboard')
  keys.children = [{ attributes: { bounds: '[40,1600][200,1700]', class: 'android.widget.Button' } }]
  expect(measureNative(parseHierarchy(JSON.stringify(tree)), 'android').problems).toEqual([])
})

test('inspect_screen gives the gate the same unnamed control as the hierarchy', () => {
  // iOS omits the class from its schema; Android lists it with an empty default.
  const ios = {
    ui_schema: { defaults: { txt: '', hint: '', rid: '', val: '', a11y: '' } },
    elements: [{ b: '[0,0][440,956]', a11y: 'Thunderbolt Dev', c: [{ b: '[25,712][51,738]', txt: '0', val: '0' }] }],
  }
  const android = {
    ui_schema: { defaults: { txt: '', hint: '', rid: '', a11y: '', cls: '' } },
    elements: [{ b: '[0,0][1080,2400]', c: [{ b: '[50,1500][110,1560]', cls: 'android.widget.CheckBox' }] }],
  }
  const line = ['[qa-layout] unnamed-control checkbox "at the start"']
  expect(measureNative(parseInspectScreen(JSON.stringify(ios)), 'ios').problems).toEqual(line)
  expect(measureNative(parseInspectScreen(JSON.stringify(android)), 'android').problems).toEqual(line)
})

test('on a device the probe line for a control the tree reports is left out, so one control is one finding', () => {
  const button = '[qa-layout] unnamed-control button "arrow-left icon after Connect Google"'
  const checkbox = '[qa-layout] unnamed-control checkbox "#terms-agreement"'
  const covered = '[qa-layout] covered button "Continue"'
  const kept = (platform: 'ios' | 'android') =>
    [button, checkbox, covered].filter((line) => keepsProbeLine(line, platform))
  // Android's tree names every control's role; iOS's only shows the checkable ones.
  expect(kept('android')).toEqual([covered])
  expect(kept('ios')).toEqual([button, covered])
})
