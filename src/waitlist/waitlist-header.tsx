/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppLogo } from '@/components/app-logo'

/**
 * Shared branding header for waitlist pages.
 * Displays the Thunderbolt logo and wordmark.
 */
export const WaitlistHeader = () => (
  <div className="flex w-full items-center justify-center gap-1">
    <AppLogo size={16} />
    <span className="font-brand text-xl font-medium leading-7 tracking-[-0.4px] text-foreground">Thunderbolt</span>
  </div>
)
