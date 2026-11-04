/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { SVGProps } from 'react'

/** Stacked round chat bubbles on the same grid and stroke as MessageCircle. */
export const MessagesCircleStacked = (props: SVGProps<SVGSVGElement>) => (
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
    <path d="M8 3.2A8 8 0 0 1 21 9.5c0 2-.7 3.8-1.9 5.2" />
    <path d="M17 13.5a7.5 7.5 0 0 1-10.5 6.87l-3.8 1.1a.6.6 0 0 1-.74-.73l1.1-3.7A7.5 7.5 0 1 1 17 13.5Z" />
  </svg>
)
