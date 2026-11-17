/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react'
import { AuthScreen, AuthScreenHeading } from '@/components/auth-screen'

type SsoSignInLayoutProps = {
  title: ReactNode
  description: ReactNode
  children: ReactNode
}

/** The auth card the SSO sign-in steps share. */
export const SsoSignInLayout = ({ title, description, children }: SsoSignInLayoutProps) => (
  <AuthScreen>
    <AuthScreenHeading title={title} description={description} />
    <div className="flex w-full flex-col gap-4">{children}</div>
  </AuthScreen>
)
