/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react'
import { AppWordmark } from '@/components/app-wordmark'

type SsoSignInLayoutProps = {
  title: ReactNode
  description: ReactNode
  children: ReactNode
}

/** The centered card the SSO sign-in steps share. */
export const SsoSignInLayout = ({ title, description, children }: SsoSignInLayoutProps) => (
  <div className="flex h-dvh w-full flex-col items-center justify-center px-6">
    <div className="flex w-full max-w-sm flex-col items-center gap-8 text-center">
      <AppWordmark />
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-[length:var(--font-size-body)] text-muted-foreground">{description}</p>
      </div>
      <div className="flex w-full flex-col gap-3">{children}</div>
    </div>
  </div>
)
