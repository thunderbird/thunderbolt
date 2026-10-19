/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The layout measurement for the native apps, over the tree Maestro dumps. It covers what the tree can show
// (Ruling 5): focus-covered, behind-keyboard for the focused field, and horizontal offscreen. The tree does not say
// what is drawn on top or what scrolls, so covered and vertical offscreen stay with the web probe and the screenshot.

import type { LayoutProblem } from './layout'

export type Rect = { left: number; top: number; right: number; bottom: number }

export type NativeNode = {
  bounds: Rect
  label: string
  hint: string
  id: string
  focused: boolean
  children: NativeNode[]
}

export type NativeMeasure = { keyboard?: Rect; problems: LayoutProblem[] }

type HierarchyNode = { attributes: Record<string, string>; children?: HierarchyNode[] }

type InspectElement = {
  b: string
  txt?: string
  rid?: string
  a11y?: string
  hint?: string
  val?: string
  focused?: boolean
  c?: InspectElement[]
}

type InspectScreen = { ui_schema: { defaults: Partial<InspectElement> }; elements: InspectElement[] }

/** Reads Maestro's `[left,top][right,bottom]` bounds. */
const parseBounds = (text: string): Rect => {
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(text)
  if (!match) throw new Error(`Unreadable bounds: ${text}`)
  const [left, top, right, bottom] = match.slice(1).map(Number)
  return { left, top, right, bottom }
}

const hasArea = ({ left, top, right, bottom }: Rect) => right > left && bottom > top

// inspect_screen leaves out nodes without a frame and lifts their children, so the hierarchy does the same.
const framed = (node: NativeNode): NativeNode[] => (hasArea(node.bounds) ? [node] : node.children)

/** The screen: one root over the top-level windows, sized to cover them. */
const screenOf = (children: NativeNode[]): NativeNode => ({
  bounds: children
    .map((child) => child.bounds)
    .reduce((a, b) => ({
      left: Math.min(a.left, b.left),
      top: Math.min(a.top, b.top),
      right: Math.max(a.right, b.right),
      bottom: Math.max(a.bottom, b.bottom),
    })),
  label: '',
  hint: '',
  id: '',
  focused: false,
  children,
})

const fromHierarchy = ({ attributes, children = [] }: HierarchyNode): NativeNode[] =>
  framed({
    bounds: parseBounds(attributes.bounds),
    label: attributes.accessibilityText || attributes.text || attributes.value || '',
    hint: attributes.hintText ?? '',
    id: attributes['resource-id'] ?? '',
    focused: attributes.focused === 'true',
    children: children.flatMap(fromHierarchy),
  })

/** Parses `maestro hierarchy` output, whose keys sit in `attributes`. */
export const parseHierarchy = (json: string): NativeNode => {
  const tree: HierarchyNode = JSON.parse(json)
  return screenOf(fromHierarchy(tree))
}

/** Parses the JSON of the MCP `inspect_screen` tool: abbreviated keys, with omitted ones taken from `ui_schema`. */
export const parseInspectScreen = (json: string): NativeNode => {
  const screen: InspectScreen = JSON.parse(json)
  const fromInspect = (element: InspectElement): NativeNode[] => {
    const full = { ...screen.ui_schema.defaults, ...element }
    return framed({
      bounds: parseBounds(full.b),
      label: full.a11y || full.txt || full.val || '',
      hint: full.hint ?? '',
      id: full.rid ?? '',
      focused: full.focused ?? false,
      children: (full.c ?? []).flatMap(fromInspect),
    })
  }
  return screenOf(screen.elements.flatMap(fromInspect))
}

const allNodes = (node: NativeNode): NativeNode[] => [node, ...node.children.flatMap(allNodes)]

/** The part of the tree that is our app's own content. */
const appContent = (root: NativeNode, platform: 'ios' | 'android'): NativeNode => {
  // shortcut: Android measures the whole tree until Task 14 gives it its own rule from a real dump.
  if (platform === 'android') return root
  // iOS puts the system edit menu, the keys and the status bar in windows other than the app's first one.
  const window = root.children[0]?.children[0]
  if (!window) throw new Error('The iOS tree has no app window')
  return window
}

const overlaps = (a: Rect, b: Rect) =>
  Math.min(a.right, b.right) - Math.max(a.left, b.left) >= 4 &&
  Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) >= 4

const isInside = (inner: Rect, outer: Rect) =>
  inner.left >= outer.left && inner.right <= outer.right && inner.top >= outer.top && inner.bottom <= outer.bottom

const sameRect = (a: Rect, b: Rect) => isInside(a, b) && isInside(b, a)

const name = (text: string) => `"${text.replace(/\s+/g, ' ').trim().slice(0, 50)}"`

/** The one focused leaf. When several distinct leaves report focus (a WebView can mark every node), there is none. */
const focusedLeaf = (leaves: NativeNode[]): NativeNode | undefined => {
  const [first, ...rest] = leaves.filter((leaf) => leaf.focused)
  return first && rest.every((leaf) => sameRect(leaf.bounds, first.bounds)) ? first : undefined
}

/** Measures one screen. iOS reads the keyboard from the `inputView` node; Android has no keyboard yet (Task 14). */
export const measureNative = (root: NativeNode, platform: 'ios' | 'android'): NativeMeasure => {
  const screen = root.bounds
  const keyboard = platform === 'ios' ? allNodes(root).find((node) => node.id === 'inputView')?.bounds : undefined
  const leaves = allNodes(appContent(root, platform)).filter((node) => node.children.length === 0)
  const candidates = leaves.filter((node) => node.label || node.hint)
  const focused = focusedLeaf(leaves)
  const describe = (node: NativeNode) =>
    node === focused || node.hint ? `textbox ${name(node.hint || node.label)}` : `element ${name(node.label)}`

  // A node wholly past a side edge is a drawer parked off canvas on purpose.
  const offscreen = candidates
    .filter(
      ({ bounds }) =>
        (bounds.left < screen.left && bounds.right > screen.left) ||
        (bounds.right > screen.right && bounds.left < screen.right),
    )
    .map((node): LayoutProblem => ({ kind: 'offscreen', target: describe(node) }))
  return { keyboard, problems: dedupe([...offscreen, ...focusProblems(focused, candidates, keyboard)]) }
}

/** behind-keyboard and focus-covered for the focused field. */
const focusProblems = (focused: NativeNode | undefined, candidates: NativeNode[], keyboard?: Rect): LayoutProblem[] => {
  if (!focused) return []
  const target = `textbox ${name(focused.hint || focused.label)}`
  const behind = keyboard !== undefined && (focused.bounds.top + focused.bounds.bottom) / 2 > keyboard.top
  // Leaves cannot hold each other, so a candidate is never the field's ancestor or descendant.
  const coveredByNode = candidates.some(
    (node) => node !== focused && !isInside(node.bounds, focused.bounds) && overlaps(node.bounds, focused.bounds),
  )
  // One bug, one line: a field behind-keyboard reports is not focus-covered by the same keyboard.
  const coveredByKeyboard = keyboard !== undefined && !behind && overlaps(keyboard, focused.bounds)
  const checks: [boolean, LayoutProblem['kind']][] = [
    [behind, 'behind-keyboard'],
    [coveredByNode || coveredByKeyboard, 'focus-covered'],
  ]
  return checks.filter(([found]) => found).map(([, kind]) => ({ kind, target }))
}

const dedupe = (problems: LayoutProblem[]) => [
  ...new Map(problems.map((problem) => [`${problem.kind} ${problem.target}`, problem])).values(),
]

const rect = ({ left, top, right, bottom }: Rect) => `[${left},${top}][${right},${bottom}]`

/** The `[qa-layout]` lines for one measurement: the ready line with the keyboard, then one line per problem. */
export const layoutLines = ({ keyboard, problems }: NativeMeasure): string[] => [
  `[qa-layout] ready keyboard=${keyboard ? rect(keyboard) : 'none'}`,
  ...problems.map(({ kind, target }) => `[qa-layout] ${kind} ${target}`),
]
