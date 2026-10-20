/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// What the native harness reads from the tree Maestro dumps: the screen and the on-screen keyboard. Layout problems
// come from the web probe injected into every native QA build (plan Ruling 15): the tree has no z-order and leaves
// out unlabelled boxes, so it missed the onboarding name bug and invented a cover on the city step. One rule stays on
// the tree, Android's behind-keyboard, because the Android WebView never sees the keyboard.

import platforms from './platforms.json'

export type Rect = { left: number; top: number; right: number; bottom: number }

export type NativeNode = {
  bounds: Rect
  label: string
  hint: string
  id: string
  focused: boolean
  children: NativeNode[]
}

/** The keyboard, and the `[qa-layout]` lines of the tree's own rule. */
export type NativeMeasure = { keyboard?: Rect; problems: string[] }

type HierarchyNode = { attributes: Record<string, string>; children?: HierarchyNode[] }

type InspectElement = {
  b?: string
  txt?: string
  rid?: string
  a11y?: string
  hint?: string
  val?: string
  focused?: boolean
  c?: InspectElement[]
}

type InspectScreen = { ui_schema: { defaults: Partial<InspectElement> }; elements: InspectElement[] }

/** Reads Maestro's `[left,top][right,bottom]` bounds. A node without any, like the Android root, has no frame. */
const parseBounds = (text: string | undefined): Rect => {
  if (text === undefined) return { left: 0, top: 0, right: 0, bottom: 0 }
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

const overlaps = (a: Rect, b: Rect) =>
  Math.min(a.right, b.right) - Math.max(a.left, b.left) >= 4 &&
  Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) >= 4

const sameRect = (a: Rect, b: Rect) =>
  a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom

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
 * with equal bounds once. Some inputs show as a box with the hint over their text leaves, so the field is the nearest
 * focused ancestor with a hint, or the leaf itself.
 */
const focusedField = (root: NativeNode): NativeNode | undefined => {
  const [first, ...rest] = allNodes(root).filter((node) => node.focused && node.children.length === 0)
  if (!first || !rest.every((leaf) => sameRect(leaf.bounds, first.bounds))) return undefined
  return pathTo(root, first).findLast((node) => node.focused && node.hint) ?? first
}

const androidAppId = (platforms as { id: string; appId?: string }[]).find((entry) => entry.id === 'android')?.appId

/** The top-level window that holds the app's own views (`<appId>:id/…`), which leaves out the keyboard's window. */
const appWindow = (root: NativeNode) =>
  root.children.find((window) => allNodes(window).some((node) => node.id.startsWith(`${androidAppId}:id/`)))

const keyboardNode = {
  ios: (node: NativeNode) => node.id === 'inputView',
  // Gboard's keys; the IME window's own top node spans far above them.
  android: (node: NativeNode) => node.id.endsWith(':id/keyboard_holder'),
}

/**
 * One screen: the keyboard (iOS's `inputView` node, Android's `keyboard_holder`), and on Android a `behind-keyboard`
 * line when the keyboard covers the app's focused field by at least 4 units on both axes. The Android WebView keeps its
 * full height with the keyboard up (run 39373388149), so the probe cannot see it there; on iOS the probe can. The
 * keyboard is drawn over everything, so the rule needs no stacking order.
 */
export const measureNative = (root: NativeNode, platform: 'ios' | 'android'): NativeMeasure => {
  const keyboard = allNodes(root).find(keyboardNode[platform])?.bounds
  const window = platform === 'android' && keyboard ? appWindow(root) : undefined
  const field = window && focusedField(window)
  if (!keyboard || !field || !overlaps(field.bounds, keyboard)) return { keyboard, problems: [] }
  const name = (field.hint || field.label).replace(/\s+/g, ' ').trim().slice(0, 50)
  return { keyboard, problems: [`[qa-layout] behind-keyboard textbox "${name}"`] }
}

const rect = ({ left, top, right, bottom }: Rect) => `[${left},${top}][${right},${bottom}]`

/** The native ready line, `[qa-layout] ready keyboard=[l,t][r,b]` or `keyboard=none`. */
export const readyLine = ({ keyboard }: Pick<NativeMeasure, 'keyboard'>) =>
  `[qa-layout] ready keyboard=${keyboard ? rect(keyboard) : 'none'}`

/** The probe's line for the field the positive control covers: the sign-in Email field. */
export const controlTarget = 'textbox "Email"'

/**
 * The positive control's verdict (spec 6.3), from the hierarchy `maestro hierarchy` dumped and the WebView log of the
 * run: the probe reported ready, the keyboard is open and the probe logged `focus-covered` for the Email field.
 * `lines` is what the control prints: the ready line, the probe's lines and a failure reason.
 */
export const controlVerdict = (opts: { hierarchy: string; log: string; platform: 'ios' | 'android' }) => {
  const { keyboard } = measureNative(parseHierarchy(opts.hierarchy), opts.platform)
  const logged = opts.log
    .split('\n')
    .filter((line) => line.includes('[qa-layout]'))
    .map((line) => line.slice(line.indexOf('[qa-layout]')).trim())
  const probeReady = logged.includes('[qa-layout] ready')
  const probe = logged.filter((line) => line !== '[qa-layout] ready')
  const keyboardOk = keyboard !== undefined
  const covered = probe.includes(`[qa-layout] focus-covered ${controlTarget}`)
  return {
    ok: probeReady && keyboardOk && covered,
    lines: [
      readyLine({ keyboard }),
      ...probe,
      ...(keyboardOk ? [] : ['[qa-control] the keyboard is not open']),
      // A dead log stream or a build without the probe reads differently from a probe that saw no cover.
      ...(probeReady ? [] : ['[qa-control] the layout probe never reported ready']),
      ...(covered || !probeReady ? [] : [`[qa-control] no focus-covered line for ${controlTarget}`]),
    ],
  }
}
