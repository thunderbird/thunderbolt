/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { BrandGradientIcon } from '@/components/ui/brand-gradient-icon'

/**
 * Lucide's TriangleAlert outline drawn with the brand gradient stroke.
 * Used as the standalone attention glyph on informational screens.
 */
export const GradientTriangleAlert = ({ className }: { className?: string }) => (
  <BrandGradientIcon className={className}>
    {(stroke) => (
      <>
        {/* Path data mirrors lucide-react's TriangleAlert so the glyph stays identical. */}
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" stroke={stroke} />
        <path d="M12 9v4" stroke={stroke} />
        <path d="M12 17h.01" stroke={stroke} />
      </>
    )}
  </BrandGradientIcon>
)
