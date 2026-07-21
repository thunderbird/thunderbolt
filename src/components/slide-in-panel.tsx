/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react'

// Linear's spring curve — fast start, smooth tail, no overshoot.
const slideEasing = 'cubic-bezier(0.32, 0.72, 0, 1)'

/**
 * An inline right-side detail panel (no overlay, no portal). Rendered as a real
 * flex child so the sibling list to its left shrinks to make room instead of
 * being covered. Opening animates a width + translate combo: the width reflows
 * the list smaller while the content slides in from the right. Fills the height
 * of its flex row; the caller styles/scrolls the `children`.
 *
 * `width` must be viewport-relative or fixed (vw/px/clamp), not a percentage —
 * the inner content div reuses it as a stable width while the outer collapses
 * to 0, and a percentage would resolve against the collapsed parent.
 */
export const SlideInPanel = ({ open, width, children }: { open: boolean; width: string; children: ReactNode }) => (
  <aside
    // z-30 lifts the panel above the layout's top header scrim (z-20) so the
    // gradient fades out over the list only and never washes over the panel's
    // top edge. The panel starts below the header, so nothing else competes.
    className="relative z-30 h-full shrink-0 overflow-hidden transition-[width] duration-300 motion-reduce:transition-none"
    style={{ width: open ? width : '0px', transitionTimingFunction: slideEasing }}
    aria-hidden={!open}
    inert={!open}
  >
    <div
      className="h-full transition-transform duration-300 motion-reduce:transition-none"
      style={{
        width,
        transform: open ? 'translateX(0)' : 'translateX(100%)',
        transitionTimingFunction: slideEasing,
      }}
    >
      {children}
    </div>
  </aside>
)
