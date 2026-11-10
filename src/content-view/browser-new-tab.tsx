/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import { AppLogo } from '@/components/app-logo'
import './browser-new-tab.css'

export const BrowserNewTab = ({ children }: { children?: ReactNode }) => (
  <div data-browser-new-tab className="absolute inset-0 flex overflow-auto bg-background">
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 opacity-[0.07] [background-image:radial-gradient(ellipse_at_50%_40%,var(--color-brand-2),transparent_65%)]"
    />
    <div className="relative m-auto flex w-full max-w-sm flex-col items-center gap-6 px-6 py-12 text-center">
      <div className="size-24 [perspective:480px]">
        <AppLogo size={96} className="browser-new-tab-logo" />
      </div>
      <p className="text-sm leading-relaxed text-muted-foreground">
        {children || (
          <Trans>
            Enter a URL above
            <br /> or ask your agent to open a page.
          </Trans>
        )}
      </p>
    </div>
  </div>
)
