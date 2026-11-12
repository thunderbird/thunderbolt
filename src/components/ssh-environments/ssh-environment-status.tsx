/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { Link2Off } from 'lucide-react'
import { useSshEnvironmentStatus } from '@/agent-execution/use-ssh-environment-status'
import { cn } from '@/lib/utils'

/** Connection health verifies authentication and the remote agent runtime independently of project folders. */
export const SshEnvironmentStatus = ({ environmentId }: { environmentId: string }) => {
  const { t } = useLingui()
  const { status, error } = useSshEnvironmentStatus(environmentId)
  if (status === 'unavailable') {
    const label = t`SSH environment unavailable`
    return (
      <span
        role="status"
        aria-label={label}
        title={error ?? label}
        className="inline-flex shrink-0 text-muted-foreground"
      >
        <Link2Off className="size-3.5" aria-hidden="true" />
      </span>
    )
  }
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
      title={error ?? label}
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        status === 'connected' ? 'bg-green-500' : status === 'disconnected' ? 'bg-destructive' : 'bg-muted-foreground',
      )}
    />
  )
}
