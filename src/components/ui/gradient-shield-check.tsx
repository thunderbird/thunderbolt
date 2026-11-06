/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { BrandGradientIcon } from '@/components/ui/brand-gradient-icon'

/** Lucide's ShieldCheck outline drawn with the same brand gradient as the private-model lock. */
export const GradientShieldCheck = ({ className }: { className?: string }) => (
  <BrandGradientIcon className={className}>
    {(stroke) => (
      <>
        <path
          d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"
          stroke={stroke}
        />
        <path d="m9 12 2 2 4-4" stroke={stroke} />
      </>
    )}
  </BrandGradientIcon>
)
