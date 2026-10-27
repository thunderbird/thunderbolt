/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// What the native harness reads from the tree Maestro dumps: the screen and the on-screen keyboard. Layout problems
// come from the web probe injected into every native QA build: the tree has no z-order and leaves
// out unlabelled boxes, so it can miss a field the keyboard hides and report a cover that is not there. Two rules stay on
// the tree: Android's behind-keyboard, because the Android WebView never sees the keyboard, and unnamed-control,
// because the name a screen reader reads comes from the platform's accessibility tree, not from the page.

import platforms from './platforms.json'

export type Rect = { left: number; top: number; right: number; bottom: number }

export type NativeNode = {
  bounds: Rect
  label: string
  hint: string
  id: string
  focused: boolean
  /** The control's role (`button`, `checkbox`, …), or empty when the node is no control the tree can tell. */
  role: string
  /** What a screen reader reads for the node. */
  name: string
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
  cls?: string
  focused?: boolean
  c?: InspectElement[]
}

type InspectScreen = { ui_schema: { defaults: Partial<InspectElement> }; elements: InspectElement[] }

/** A node without bounds, like the Android root, has no frame. */
const parseBounds = (text: string | undefined): Rect => {
  if (text === undefined) return { left: 0, top: 0, right: 0, bottom: 0 }
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(text)
  if (!match) throw new Error(`Unreadable bounds: ${text}`)
  const [left, top, right, bottom] = match.slice(1).map(Number)
  return { left, top, right, bottom }
}

// Chrome's WebView names a control's Android class after its role.
const androidRoles = new Map([
  ['android.widget.Button', 'button'],
  ['android.widget.CheckBox', 'checkbox'],
  ['android.widget.RadioButton', 'radio'],
  ['android.widget.Switch', 'switch'],
  ['android.widget.ToggleButton', 'switch'],
  ['android.widget.EditText', 'textbox'],
  ['android.widget.Spinner', 'combobox'],
])

// A field's text is its value, never its name, as in the web probe.
const fieldRoles = new Set(['textbox', 'combobox'])

const androidControl = (node: { cls: string; a11y: string; txt: string; hint: string }) => {
  const role = androidRoles.get(node.cls) ?? ''
  return { role, name: node.a11y || node.hint || (fieldRoles.has(role) ? '' : node.txt) }
}

// shortcut: on iOS only a checkable control shows (a leaf whose value is its state, 0 or 1), always as `checkbox`; an
// unnamed button, link or field looks like any empty box there. Read the element type once Maestro's iOS tree has one.
/**
 * Android nodes carry a class. iOS nodes carry no element type, and their text is the value, so the name is the label
 * or the placeholder. A heading container also carries a value, its level, which is why an iOS control must be a leaf.
 */
const controlOf = (node: { cls?: string; a11y: string; txt: string; hint: string; val: string; leaf: boolean }) =>
  node.cls === undefined
    ? { role: node.leaf && /^[01]$/.test(node.val) ? 'checkbox' : '', name: node.a11y || node.hint }
    : androidControl({ ...node, cls: node.cls })

const hasArea = ({ left, top, right, bottom }: Rect) => right > left && bottom > top

// inspect_screen leaves out nodes without a frame and lifts their children, so the hierarchy does the same.
const framed = (node: NativeNode): NativeNode[] => (hasArea(node.bounds) ? [node] : node.children)

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
    role: '',
    name: '',
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
    ...controlOf({
      cls: attributes.class,
      a11y: attributes.accessibilityText ?? '',
      txt: attributes.text ?? '',
      hint: attributes.hintText ?? '',
      val: attributes.value ?? '',
      leaf: children.length === 0,
    }),
    children: children.flatMap(fromHierarchy),
  })

export const parseHierarchy = (json: string): NativeNode => {
  const tree: HierarchyNode = JSON.parse(json)
  return screenOf(fromHierarchy(tree))
}

/** `inspect_screen` omits keys that equal the defaults in `ui_schema`. */
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
      ...controlOf({
        cls: full.cls,
        a11y: full.a11y ?? '',
        txt: full.txt ?? '',
        hint: full.hint ?? '',
        val: full.val ?? '',
        leaf: (full.c ?? []).length === 0,
      }),
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

const inside = (a: Rect, b: Rect) => a.left >= b.left && a.top >= b.top && a.right <= b.right && a.bottom <= b.bottom

/** On Android, a `behind-keyboard` line when the keyboard covers the app's focused field by 4 units on both axes. */
const behindKeyboard = (root: NativeNode, platform: 'ios' | 'android', keyboard: Rect | undefined) => {
  const window = platform === 'android' && keyboard ? appWindow(root) : undefined
  const field = window && focusedField(window)
  if (!keyboard || !field || !overlaps(field.bounds, keyboard)) return []
  const name = (field.hint || field.label).replace(/\s+/g, ' ').trim().slice(0, 50)
  return [`[qa-layout] behind-keyboard textbox "${name}"`]
}

// React's and Radix's ids (`:r3:`, `«r3»`, `_r_3_`, `radix-…`) change between renders, as in the probe. It also
// leaves out Android's own view ids (`<package>:id/…`).
const generatedId = /[:«»]|_r_|^radix-/

/** A leaf's text for `whereOf`: a control's name, never its value or state, and nothing for a container. */
const textOf = (node: NativeNode) =>
  node.children.length > 0 ? '' : (node.role ? node.name : node.label).replace(/\s+/g, ' ').trim()

/**
 * Which unnamed control `node` is, in the probe's form where the tree allows it: the page's `id`, which Android's
 * WebView passes on as the resource id, else the nearest text before it in `nodes`, read from leaves only since a
 * container repeats its children's text.
 */
const whereOf = (node: NativeNode, nodes: NativeNode[]) => {
  if (node.id && !generatedId.test(node.id)) return `#${node.id}`
  const before = nodes.slice(0, nodes.indexOf(node)).findLast((earlier) => textOf(earlier) !== '')
  return before ? `after ${textOf(before).slice(0, 40)}` : 'at the start'
}

/**
 * Two controls with the same quote are one line. On Android only the app's window counts, which leaves out the
 * keyboard and a browser tab over the app; on iOS the keys sit in the app's own tree, so the nodes inside the
 * keyboard's frame are left out.
 */
const unnamedControls = (root: NativeNode, platform: 'ios' | 'android', keyboard: Rect | undefined) => {
  const nodes = platform === 'android' ? allNodes(appWindow(root) ?? root) : allNodes(root)
  const keys = platform === 'ios' ? keyboard : undefined
  return [
    ...new Set(
      nodes
        .filter((node) => node.role && !node.name.trim() && !(keys && inside(node.bounds, keys)))
        .map((node) => `[qa-layout] unnamed-control ${node.role} "${whereOf(node, nodes).slice(0, 80)}"`),
    ),
  ]
}

// The probe's roles for the controls the tree reports. Chrome's WebView shows a searchbox as a text field.
const treeRoles = {
  android: new Set([...androidRoles.values(), 'searchbox']),
  ios: new Set(['checkbox', 'radio', 'switch']),
}

/**
 * Whether the gate and the replay keep a line the probe logged on a device. The tree reports `unnamed-control` for
 * the controls it can see and quotes them from the tree, so the probe's line for one of them would be a second
 * finding with another fingerprint. A role the tree never reports, like a link, keeps the probe's line.
 */
export const keepsProbeLine = (line: string, platform: 'ios' | 'android') => {
  const role = /\] unnamed-control (\S+) /.exec(line)?.[1]
  return role === undefined || !treeRoles[platform].has(role)
}

/**
 * The Android WebView keeps its full height with the keyboard up, so the probe cannot see it there; on iOS the probe
 * can. The keyboard is drawn over everything, so the rule needs no stacking order.
 */
export const measureNative = (root: NativeNode, platform: 'ios' | 'android'): NativeMeasure => {
  const keyboard = allNodes(root).find(keyboardNode[platform])?.bounds
  return {
    keyboard,
    problems: [...behindKeyboard(root, platform, keyboard), ...unnamedControls(root, platform, keyboard)],
  }
}

const rect = ({ left, top, right, bottom }: Rect) => `[${left},${top}][${right},${bottom}]`

export const readyLine = ({ keyboard }: Pick<NativeMeasure, 'keyboard'>) =>
  `[qa-layout] ready keyboard=${keyboard ? rect(keyboard) : 'none'}`

/** The sign-in Email field, which the positive control covers. */
export const controlTarget = 'textbox "Email"'

/** `lines` is what the control prints: the ready line, the probe's lines and a failure reason. */
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
