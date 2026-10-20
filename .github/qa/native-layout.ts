/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// What the native harness reads from the tree Maestro dumps: the screen and the on-screen keyboard. Layout problems
// come from the web probe injected into every native QA build (plan Ruling 15): the tree has no z-order and leaves
// out unlabelled boxes, so it missed the onboarding name bug and invented a cover on the city step.

export type Rect = { left: number; top: number; right: number; bottom: number }

export type NativeNode = { bounds: Rect; label: string; id: string; children: NativeNode[] }

export type NativeMeasure = { keyboard?: Rect }

type HierarchyNode = { attributes: Record<string, string>; children?: HierarchyNode[] }

type InspectElement = { b: string; txt?: string; rid?: string; a11y?: string; val?: string; c?: InspectElement[] }

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
    id: '',
    children,
  }
}

const fromHierarchy = ({ attributes, children = [] }: HierarchyNode): NativeNode[] =>
  framed({
    bounds: parseBounds(attributes.bounds),
    label: attributes.accessibilityText || attributes.text || attributes.value || '',
    id: attributes['resource-id'] ?? '',
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
      id: full.rid ?? '',
      children: (full.c ?? []).flatMap(fromInspect),
    })
  }
  return screenOf(screen.elements.flatMap(fromInspect))
}

const allNodes = (node: NativeNode): NativeNode[] => [node, ...node.children.flatMap(allNodes)]

/** The keyboard on one screen: iOS reads it from the `inputView` node; Android has none in the tree yet (Task 14). */
export const measureNative = (root: NativeNode, platform: 'ios' | 'android'): NativeMeasure => ({
  keyboard: platform === 'ios' ? allNodes(root).find((node) => node.id === 'inputView')?.bounds : undefined,
})

const rect = ({ left, top, right, bottom }: Rect) => `[${left},${top}][${right},${bottom}]`

/** The native ready line, `[qa-layout] ready keyboard=[l,t][r,b]` or `keyboard=none`. */
export const readyLine = ({ keyboard }: NativeMeasure) =>
  `[qa-layout] ready keyboard=${keyboard ? rect(keyboard) : 'none'}`

/** The probe's line for the field the positive control covers: the sign-in Email field. */
export const controlTarget = 'textbox "Email"'

/**
 * The positive control's verdict (spec 6.3), from the hierarchy `maestro hierarchy` dumped and the WebView log of the
 * run: the keyboard is open (iOS only, Android has no keyboard in the tree yet) and the probe logged `focus-covered`
 * for the Email field. `lines` is what the control prints: the ready line, the probe's lines and a failure reason.
 */
export const controlVerdict = (opts: { hierarchy: string; log: string; platform: 'ios' | 'android' }) => {
  const { keyboard } = measureNative(parseHierarchy(opts.hierarchy), opts.platform)
  const probe = opts.log
    .split('\n')
    .filter((line) => line.includes('[qa-layout]'))
    .map((line) => line.slice(line.indexOf('[qa-layout]')).trim())
    .filter((line) => !line.startsWith('[qa-layout] ready'))
  const keyboardOk = opts.platform === 'android' || keyboard !== undefined
  const covered = probe.includes(`[qa-layout] focus-covered ${controlTarget}`)
  return {
    ok: keyboardOk && covered,
    lines: [
      readyLine({ keyboard }),
      ...probe,
      ...(keyboardOk ? [] : ['[qa-control] the keyboard is not open']),
      ...(covered ? [] : [`[qa-control] no focus-covered line for ${controlTarget}`]),
    ],
  }
}
