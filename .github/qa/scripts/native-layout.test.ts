/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { layoutLines, measureNative, type NativeNode, parseHierarchy, parseInspectScreen } from '../native-layout'

const fixture = (name: string) => readFileSync(join(import.meta.dir, '../fixtures/native', name), 'utf8')

const allNodes = (node: NativeNode): NativeNode[] => [node, ...node.children.flatMap(allNodes)]

test('the iOS name step reports the bar over the focused field (the keyboard bug)', () => {
  const measure = measureNative(parseHierarchy(fixture('hier-name-kb.json')), 'ios')
  expect(measure.keyboard).toEqual({ left: 0, top: 611, right: 440, bottom: 956 })
  expect(measure.problems).toEqual([{ kind: 'focus-covered', target: 'textbox "Enter your name"' }])
  expect(layoutLines(measure)).toEqual([
    '[qa-layout] ready keyboard=[0,611][440,956]',
    '[qa-layout] focus-covered textbox "Enter your name"',
  ])
})

test('the same step on the runner, with the field lower down, reports the same problem', () =>
  expect(measureNative(parseHierarchy(fixture('hier-name-kb-runner.json')), 'ios').problems).toContainEqual({
    kind: 'focus-covered',
    target: 'textbox "Enter your name"',
  }))

test('the city step covers only text, so the measurement stays quiet (it is a visual finding)', () =>
  expect(measureNative(parseHierarchy(fixture('hier-city-kb.json')), 'ios').problems).toEqual([]))

test.each(['hier-name-kb.json', 'hier-city-kb.json'])(
  'the edit menu Back arrow half past the left edge in %s is iOS chrome, not an offscreen problem',
  (name) => {
    const root = parseHierarchy(fixture(name))
    const back = allNodes(root).find((node) => node.label === 'Back')
    expect(back?.bounds.left).toBe(-11)
    expect(measureNative(root, 'ios').problems.filter((problem) => problem.kind === 'offscreen')).toEqual([])
  },
)

test('the welcome screen, where every web node reports focus, has no focused field and is clean', () => {
  const root = parseHierarchy(fixture('hier-00-welcome.json'))
  expect(allNodes(root).filter((node) => node.focused)).toHaveLength(17)
  expect(measureNative(root, 'ios')).toEqual({ keyboard: undefined, problems: [] })
  expect(layoutLines(measureNative(root, 'ios'))).toEqual(['[qa-layout] ready keyboard=none'])
})

test('inspect_screen and hierarchy give the same lines for a chat composer with the keyboard open', () =>
  expect(layoutLines(measureNative(parseInspectScreen(fixture('inspect-chat-kb.json')), 'ios'))[0]).toMatch(
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

const node = ([left, top, right, bottom]: number[], fields: Partial<NativeNode> = {}): NativeNode => ({
  bounds: { left, top, right, bottom },
  label: '',
  hint: '',
  id: '',
  focused: false,
  children: [],
  ...fields,
})

const field = (bounds = [24, 178, 416, 222]) => node(bounds, { hint: 'Enter your name', focused: true })

/** An iOS-shaped tree: the app's content in its first window, the keyboard placeholder and the keys in others. */
const syntheticTree = (content: NativeNode[], keyboard?: { top: number; keys?: NativeNode[] }): NativeNode => {
  const windows = [node([0, 0, 440, 956], { children: content })]
  const keyboardWindows = keyboard
    ? [
        node([0, 0, 440, 956], { children: [node([0, keyboard.top, 440, 956], { id: 'inputView' })] }),
        node([0, 0, 440, 956], { children: keyboard.keys ?? [] }),
      ]
    : []
  const app = node([0, 0, 440, 956], { label: 'Thunderbolt Dev', children: [...windows, ...keyboardWindows] })
  return node([0, 0, 440, 956], { children: [app] })
}

const problemsOf = (root: NativeNode) => measureNative(root, 'ios').problems

test('an icon inside the focused field is not a cover', () =>
  // The focused field [24,178][416,222] holds a "Clear" node at [380,186][408,214].
  expect(problemsOf(syntheticTree([field(), node([380, 186, 408, 214], { label: 'Clear' })]))).toEqual([]))

test('a cover needs 4 pt of overlap on both axes', () => {
  expect(problemsOf(syntheticTree([field(), node([246, 219, 312, 263], { label: 'Skip' })]))).toEqual([])
  expect(problemsOf(syntheticTree([field(), node([246, 218, 312, 262], { label: 'Skip' })]))).toEqual([
    { kind: 'focus-covered', target: 'textbox "Enter your name"' },
  ])
})

test('several distinct focused leaves mean nothing has focus, while equal duplicates still count as one', () => {
  const terms = node([227, 788, 324, 803], { label: 'Terms of Service', focused: true })
  const privacy = node([201, 788, 393, 818], { label: 'Privacy Policy', focused: true })
  expect(problemsOf(syntheticTree([terms, privacy]))).toEqual([])
  expect(problemsOf(syntheticTree([field(), field(), node([246, 210, 312, 254], { label: 'Skip' })]))).toEqual([
    { kind: 'focus-covered', target: 'textbox "Enter your name"' },
  ])
})

test('a node half past the right edge is offscreen, and one wholly past it is a parked drawer', () => {
  expect(problemsOf(syntheticTree([node([400, 300, 480, 340], { label: 'Next' })]))).toEqual([
    { kind: 'offscreen', target: 'element "Next"' },
  ])
  expect(problemsOf(syntheticTree([node([450, 300, 520, 340], { label: 'Drawer' })]))).toEqual([])
})

test('the keyboard over the lower edge of the field, with its center free, is focus-covered', () =>
  expect(problemsOf(syntheticTree([field()], { top: 210 }))).toEqual([
    { kind: 'focus-covered', target: 'textbox "Enter your name"' },
  ]))

test('a field with its center behind the keyboard is one behind-keyboard line, the keys included', () =>
  expect(problemsOf(syntheticTree([field()], { top: 190, keys: [node([4, 190, 47, 246], { label: 'Q' })] }))).toEqual([
    { kind: 'behind-keyboard', target: 'textbox "Enter your name"' },
  ]))

test('a cover by another node still counts when the field is behind the keyboard', () =>
  expect(problemsOf(syntheticTree([field(), node([246, 210, 312, 254], { label: 'Skip' })], { top: 190 }))).toEqual([
    { kind: 'behind-keyboard', target: 'textbox "Enter your name"' },
    { kind: 'focus-covered', target: 'textbox "Enter your name"' },
  ]))

test('targets cut the name at 50 characters and squash whitespace', () =>
  expect(problemsOf(syntheticTree([node([400, 300, 480, 340], { label: `Next\n${'x'.repeat(60)}` })]))).toEqual([
    { kind: 'offscreen', target: `element "Next ${'x'.repeat(45)}"` },
  ]))

test('Android reads no keyboard from the tree yet', () =>
  expect(measureNative(syntheticTree([field()], { top: 210 }), 'android').keyboard).toBeUndefined())
