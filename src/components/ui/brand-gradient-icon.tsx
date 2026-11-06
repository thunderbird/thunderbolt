/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useId, type ReactNode } from 'react'

/**
 * Scaffolding for a lucide-style outline icon drawn with the brand amber→raspberry
 * gradient stroke. CSS can't gradient-fill an SVG stroke, so consumers
 * re-render the glyph's path data with an inline `<linearGradient>` whose
 * stops read the theme tokens (`--color-brand-2` → `--color-brand`), matching
 * the switch ON track.
 *
 * `gradientEndX` (viewBox units; glyphs span 0–24) stretches the sweep past
 * the icon's right edge so the glyph samples only the leading slice — used
 * when a sibling element continues the same gradient (see PrivateBadge).
 */
export const BrandGradientIcon = ({
  className,
  gradientEndX = 24,
  children,
}: {
  className?: string
  gradientEndX?: number
  /** The glyph's path elements, stroked with the provided gradient url. */
  children: (stroke: string) => ReactNode
}) => {
  const gradientId = useId()
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2={gradientEndX} y2="0" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--color-brand-2)" />
          <stop offset="1" stopColor="var(--color-brand)" />
        </linearGradient>
      </defs>
      {children(`url(#${gradientId})`)}
    </svg>
  )
}
