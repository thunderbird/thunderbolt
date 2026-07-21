/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { SVGProps } from 'react'

/**
 * Lucide's `PanelLeft` with softer corners (rx 5 vs the stock 2), matching
 * the app's rounded pill aesthetic. Same 24px grid, stroke width and
 * round caps/joins as lucide-react icons, so it drops in anywhere they do.
 */
export const PanelLeftRounded = (props: SVGProps<SVGSVGElement>) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...props}
  >
    <rect width="18" height="18" x="3" y="3" rx="5" />
    <path d="M9 3v18" />
  </svg>
)
