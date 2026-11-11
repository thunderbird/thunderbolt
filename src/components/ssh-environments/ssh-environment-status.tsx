/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { useSshEnvironmentStatus } from '@/agent-execution/use-ssh-environment-status'
import { cn } from '@/lib/utils'

/** Connection health includes authentication and access to the remote workspace. */
export const SshEnvironmentStatus = ({ environmentId }: { environmentId: string }) => {
  const { t } = useLingui()
  const { status } = useSshEnvironmentStatus(environmentId)
  const label =
    status === 'connected'
      ? t`Connected`
      : status === 'checking'
        ? t`Checking connection`
        : status === 'disconnected'
          ? t`Disconnected`
          : t`Not checked`
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        status === 'connected' ? 'bg-green-500' : status === 'disconnected' ? 'bg-destructive' : 'bg-muted-foreground',
      )}
    />
  )
}
