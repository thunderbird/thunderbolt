/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The layout measurement for the native apps, over the tree Maestro dumps. It covers what the tree can show
// (Ruling 5): focus-covered and behind-keyboard for the focused field. The tree does not say what is drawn on top or
// what scrolls, so covered and offscreen stay with the web probe, and the screenshot covers them on native.

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
const screenOf = (children: NativeNode[]): NativeNode => {
  if (children.length === 0) throw new Error('The tree has no node with a frame')
  return {
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
  }
}

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

/** The nodes from `node` down to `target`, both included, or none when `target` is not below `node`. */
const pathTo = (node: NativeNode, target: NativeNode): NativeNode[] =>
  node === target
    ? [node]
    : node.children.flatMap((child) => {
        const path = pathTo(child, target)
        return path.length > 0 ? [node, ...path] : []
      })

/**
 * The focused field. Focus exists only when one leaf reports it (a WebView can mark every node), counting duplicates
 * with equal bounds once. iOS shows some inputs as a box with the hint over their text leaves, so the field is the
 * nearest focused ancestor with a hint, or the leaf itself.
 */
const focusedField = (content: NativeNode): NativeNode | undefined => {
  const [first, ...rest] = allNodes(content).filter((node) => node.focused && node.children.length === 0)
  if (!first || !rest.every((leaf) => sameRect(leaf.bounds, first.bounds))) return undefined
  return pathTo(content, first).findLast((node) => node.focused && node.hint) ?? first
}

/**
 * Measures one screen: behind-keyboard and focus-covered for the focused field. iOS reads the keyboard from the
 * `inputView` node; Android has no keyboard yet (Task 14). There is no native offscreen rule: the tree cannot tell a
 * sideways-scrolling row of chips from a broken layout, so the screenshot covers horizontal overflow.
 */
export const measureNative = (root: NativeNode, platform: 'ios' | 'android'): NativeMeasure => {
  const keyboard = platform === 'ios' ? allNodes(root).find((node) => node.id === 'inputView')?.bounds : undefined
  const content = appContent(root, platform)
  const field = focusedField(content)
  if (!field) return { keyboard, problems: [] }

  const target = `textbox ${name(field.hint || field.label)}`
  const fieldNodes = allNodes(field)
  const behind = keyboard !== undefined && (field.bounds.top + field.bounds.bottom) / 2 > keyboard.top
  const coveredByNode = allNodes(content).some(
    (node) =>
      node.children.length === 0 &&
      Boolean(node.label || node.hint) &&
      !fieldNodes.includes(node) &&
      !isInside(node.bounds, field.bounds) &&
      overlaps(node.bounds, field.bounds),
  )
  // One bug, one line: a field behind-keyboard reports is not focus-covered by the same keyboard.
  const coveredByKeyboard = keyboard !== undefined && !behind && overlaps(keyboard, field.bounds)
  const problems: LayoutProblem[] = []
  if (behind) problems.push({ kind: 'behind-keyboard', target })
  if (coveredByNode || coveredByKeyboard) problems.push({ kind: 'focus-covered', target })
  return { keyboard, problems }
}

const rect = ({ left, top, right, bottom }: Rect) => `[${left},${top}][${right},${bottom}]`

/** The `[qa-layout]` lines for one measurement: the ready line with the keyboard, then one line per problem. */
export const layoutLines = ({ keyboard, problems }: NativeMeasure): string[] => [
  `[qa-layout] ready keyboard=${keyboard ? rect(keyboard) : 'none'}`,
  ...problems.map(({ kind, target }) => `[qa-layout] ${kind} ${target}`),
]
