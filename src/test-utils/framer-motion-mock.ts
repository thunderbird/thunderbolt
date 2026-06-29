/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mock } from 'bun:test'
import { createElement, useRef, type ReactNode } from 'react'

/**
 * Process-global stub for `framer-motion`. Bun's `mock.module` persists
 * across files in the same test run, so any test that needs to bypass
 * framer-motion's animation runtime must do so by registering a mock that
 * covers every symbol *any* concurrent test file might touch — otherwise the
 * other tests crash with "Element type is invalid" when an undefined
 * re-export (e.g. `<m.ul>`, `<LayoutGroup>`, `<LazyMotion>`) is rendered.
 *
 * Import this module for its side effect from any test that wants the mock
 * applied; importing is idempotent because `mock.module` replaces by name.
 *
 * The motion-tag Proxy caches the per-tag component so React sees a stable
 * component identity across renders — without this, `<m.ul>` was returning a
 * fresh function on every access, which produced "Maximum update depth
 * exceeded" loops in tests that rendered animated lists.
 */

const motionTagCache = new Map<string, (props: Record<string, unknown>) => ReactNode>()

const createMotionTag = (tag: string) => {
  const cached = motionTagCache.get(tag)
  if (cached) {
    return cached
  }
  const Component = ({ children, ...props }: Record<string, unknown>) =>
    createElement(tag, props, children as ReactNode)
  motionTagCache.set(tag, Component)
  return Component
}

const motionTagProxy = new Proxy(
  {},
  {
    get: (_, tag: string) => createMotionTag(tag),
  },
)

/**
 * Minimal stand-in for a framer-motion `MotionValue`. Holds a value and exposes the
 * surface our components touch (`get`/`set`); subscriptions and teardown are no-ops since
 * the mock never drives a real animation loop.
 */
type MockMotionValue = {
  get: () => unknown
  set: (value: unknown) => void
  on: () => () => void
  destroy: () => void
}

const createMotionValue = (initial: unknown): MockMotionValue => {
  let current = initial
  return {
    get: () => current,
    set: (value) => {
      current = value
    },
    on: () => () => {},
    destroy: () => {},
  }
}

/** Stable `MotionValue` per component instance (mirrors framer's ref-backed hooks). */
const useStableMotionValue = (initial: unknown): MockMotionValue => {
  const ref = useRef<MockMotionValue | null>(null)
  if (ref.current === null) {
    ref.current = createMotionValue(initial)
  }
  return ref.current
}

/**
 * Spy standing in for framer-motion's `animate`. Resolves synchronously to the target so
 * awaited `animate()` end-states are deterministic; exposed as a spy so tests can assert the
 * transition argument (e.g. the instant `prefers-reduced-motion` transition). Call
 * `animateSpy.mockClear()` in a `beforeEach` to isolate per-test call history.
 */
export const animateSpy = mock((value: MockMotionValue, target: unknown, _transition?: unknown) => {
  value.set(target)
  return Promise.resolve()
})

let reducedMotion = false

/** Test hook: force `useReducedMotion()` to report (un)reduced motion. Reset per test. */
export const setMockReducedMotion = (value: boolean) => {
  reducedMotion = value
}

mock.module('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  LayoutGroup: ({ children }: { children: ReactNode }) => children,
  LazyMotion: ({ children }: { children: ReactNode }) => children,
  domAnimation: {},
  domMax: {},
  m: motionTagProxy,
  motion: motionTagProxy,
  animate: animateSpy,
  useMotionValue: (initial: unknown) => useStableMotionValue(initial),
  useReducedMotion: () => reducedMotion,
  useTransform: () => useStableMotionValue(0),
}))
