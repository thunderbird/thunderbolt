/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useId } from 'react'

/**
 * Lucide's Lock outline drawn with the brand gold→pink gradient stroke.
 * CSS can't gradient-fill an SVG stroke, so this re-renders the same paths
 * with an inline `<linearGradient>` whose stops read the theme tokens
 * (`--color-brand-2` → `--color-brand`), matching the switch ON track.
 * Same approach as GradientCloud in sidebar-footer.tsx.
 *
 * `gradientEndX` (viewBox units; the glyph spans 0–24) stretches the sweep
 * past the icon's right edge so the lock samples only the leading slice.
 * Used by the model selector's "Private" badge, where a sibling text span
 * clips the remainder of the same gradient — together they read as one
 * continuous sweep across lock + word.
 */
export const GradientLock = ({ className, gradientEndX = 24 }: { className?: string; gradientEndX?: number }) => {
  const gradientId = useId()
  const stroke = `url(#${gradientId})`
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
      {/* Path data mirrors lucide-react's Lock so the glyph stays identical. */}
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" stroke={stroke} />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" stroke={stroke} />
    </svg>
  )
}
