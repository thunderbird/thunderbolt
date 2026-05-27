/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mock } from 'bun:test'
import { createElement, type ReactNode } from 'react'

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

mock.module('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  LayoutGroup: ({ children }: { children: ReactNode }) => children,
  LazyMotion: ({ children }: { children: ReactNode }) => children,
  domAnimation: {},
  domMax: {},
  m: motionTagProxy,
  motion: motionTagProxy,
}))
