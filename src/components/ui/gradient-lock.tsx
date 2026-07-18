/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { BrandGradientIcon } from '@/components/ui/brand-gradient-icon'

/**
 * Lucide's Lock outline drawn with the brand gradient stroke.
 *
 * `gradientEndX` stretches the sweep past the icon's right edge so the lock
 * samples only the leading slice. Used by the model selector's "Private"
 * badge, where a sibling text span clips the remainder of the same gradient —
 * together they read as one continuous sweep across lock + word.
 */
export const GradientLock = ({ className, gradientEndX = 24 }: { className?: string; gradientEndX?: number }) => (
  <BrandGradientIcon className={className} gradientEndX={gradientEndX}>
    {(stroke) => (
      <>
        {/* Path data mirrors lucide-react's Lock so the glyph stays identical. */}
        <rect width="18" height="11" x="3" y="11" rx="2" ry="2" stroke={stroke} />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" stroke={stroke} />
      </>
    )}
  </BrandGradientIcon>
)
