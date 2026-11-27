/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import type { FormEvent } from 'react'
import { authButtonClass } from '@/components/auth-screen'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SsoSignInLayout } from './sso-sign-in-layout'

type SsoEmailStepProps = {
  email: string
  pending: boolean
  onEmailChange: (email: string) => void
  onSubmit: () => void
  onUseEmailCode: () => void
}

/** Asks for the work email, so the right SSO connection can be found from its domain. */
export const SsoEmailStep = ({ email, pending, onEmailChange, onSubmit, onUseEmailCode }: SsoEmailStepProps) => {
  const { t } = useLingui()

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    onSubmit()
  }

  return (
    <SsoSignInLayout
      title={<Trans>Sign in</Trans>}
      description={<Trans>Enter your work email to continue with your organization's sign-in.</Trans>}
    >
      <form onSubmit={handleSubmit} className="flex w-full flex-col gap-4">
        <Input
          type="email"
          inputMode="email"
          autoComplete="email"
          aria-label={t`Work email`}
          placeholder={t`name@company.com`}
          value={email}
          onChange={(event) => onEmailChange(event.target.value)}
          disabled={pending}
          variant="filled"
          inputSize="xl"
          className="rounded-xl"
        />
        <Button type="submit" disabled={pending || !email.includes('@')} className={authButtonClass}>
          <Trans>Continue</Trans>
        </Button>
      </form>
      <Button type="button" variant="ghost" onClick={onUseEmailCode} className={authButtonClass}>
        <Trans>Use an email code instead</Trans>
      </Button>
    </SsoSignInLayout>
  )
}
