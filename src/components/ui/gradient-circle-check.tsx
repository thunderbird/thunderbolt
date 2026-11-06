/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { BrandGradientIcon } from '@/components/ui/brand-gradient-icon'

/**
 * Lucide's CircleCheck outline drawn with the brand gradient stroke.
 * Used as the standalone success glyph on confirmation screens.
 */
export const GradientCircleCheck = ({ className }: { className?: string }) => (
  <BrandGradientIcon className={className}>
    {(stroke) => (
      <>
        {/* Path data mirrors lucide-react's CircleCheck so the glyph stays identical. */}
        <circle cx="12" cy="12" r="10" stroke={stroke} />
        <path d="m9 12 2 2 4-4" stroke={stroke} />
      </>
    )}
  </BrandGradientIcon>
)
