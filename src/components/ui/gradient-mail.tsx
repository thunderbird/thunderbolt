/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { BrandGradientIcon } from '@/components/ui/brand-gradient-icon'

/**
 * Lucide's Mail outline drawn with the brand gradient stroke.
 * Used as the standalone glyph on "check your email" screens.
 */
export const GradientMail = ({ className }: { className?: string }) => (
  <BrandGradientIcon className={className}>
    {(stroke) => (
      <>
        {/* Path data mirrors lucide-react's Mail so the glyph stays identical. */}
        <path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7" stroke={stroke} />
        <rect x="2" y="4" width="20" height="16" rx="2" stroke={stroke} />
      </>
    )}
  </BrandGradientIcon>
)
