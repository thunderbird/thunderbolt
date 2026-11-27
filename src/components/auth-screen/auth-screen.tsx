/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { BackButton } from '@/components/ui/back-button'
import type { ReactNode } from 'react'
import { AuthBrandHeader } from './auth-brand-header'
import { AuthCard } from './auth-card'
import { AuthScreenFrame } from './auth-screen-frame'

type AuthScreenProps = {
  children: ReactNode
  /** Shows the back button in the card's top-left corner. */
  onBack?: () => void
}

/** A standalone auth screen: the waitlist's frame, card and branding header around centered content. */
export const AuthScreen = ({ children, onBack }: AuthScreenProps) => (
  <AuthScreenFrame>
    <AuthCard>
      {onBack && <BackButton onClick={onBack} className="absolute left-6 top-6" />}
      <div className="flex w-full flex-1 flex-col items-center p-4">
        <AuthBrandHeader />
        {/* Scrolls inside the fixed-height desktop card; the side padding keeps focus rings unclipped. */}
        <main className="-mx-1 flex min-h-0 flex-1 flex-col justify-center-safe gap-8 self-stretch overflow-y-auto px-1 py-8">
          {children}
        </main>
      </div>
    </AuthCard>
  </AuthScreenFrame>
)
