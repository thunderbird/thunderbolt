/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { authButtonClass } from '@/components/auth-screen'
import { Button } from '@/components/ui/button'
import { SsoSignInLayout } from './sso-sign-in-layout'
import type { SsoConnectionOption } from './use-sso-sign-in-state'

type SsoConnectionListProps = {
  connections: SsoConnectionOption[]
  onChoose: (providerId: string) => void
  onUseEmailCode: () => void
}

/** One button per SSO connection, for when the email's domain doesn't decide. */
export const SsoConnectionList = ({ connections, onChoose, onUseEmailCode }: SsoConnectionListProps) => (
  <SsoSignInLayout
    title={<Trans>Choose how to sign in</Trans>}
    description={<Trans>Pick the identity provider your organization uses for you.</Trans>}
  >
    {connections.map((connection) => (
      <Button
        key={connection.providerId}
        variant="outline"
        onClick={() => onChoose(connection.providerId)}
        className={authButtonClass}
      >
        {connection.name}
      </Button>
    ))}
    <Button type="button" variant="ghost" onClick={onUseEmailCode} className={authButtonClass}>
      <Trans>Use an email code instead</Trans>
    </Button>
  </SsoSignInLayout>
)
