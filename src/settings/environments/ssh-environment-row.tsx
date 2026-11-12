/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { RefreshCw, Server } from 'lucide-react'
import type { SshEnvironment } from '@/agent-execution/ssh-environments'
import { useSshEnvironmentStatus } from '@/agent-execution/use-ssh-environment-status'
import { SshEnvironmentStatus } from '@/components/ssh-environments'
import { SettingsSelectableRow } from '@/components/settings/settings-list'
import { Button } from '@/components/ui/button'

export const SshEnvironmentRow = ({
  environment,
  selected,
  onSelect,
}: {
  environment: SshEnvironment
  selected: boolean
  onSelect: () => void
}) => {
  const { t } = useLingui()
  const { status, error, refresh } = useSshEnvironmentStatus(environment.id)
  const name = environment.name
  return (
    <div className="flex flex-col gap-2">
      <SettingsSelectableRow
        title={
          <span className="flex items-center gap-2">
            <span className="truncate">{name}</span>
            <SshEnvironmentStatus environmentId={environment.id} />
          </span>
        }
        subtitle={environment.username ? `${environment.username}@${environment.host}` : environment.host}
        leading={<Server className="size-5 text-muted-foreground" />}
        ariaLabel={t`Edit ${name}`}
        isSelected={selected}
        onSelect={onSelect}
        trailing={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={refresh}
            disabled={status === 'checking'}
            aria-label={t`Check connection to ${name}`}
            title={t`Check connection to ${name}`}
          >
            <RefreshCw className={status === 'checking' ? 'animate-spin' : undefined} />
          </Button>
        }
      />
      {error && (
        <div className="px-4 text-xs text-destructive">
          <p>
            <Trans>
              Could not connect. Check the address, credentials, trusted host key, and remote working folder.
            </Trans>
          </p>
          <pre className="mt-1 whitespace-pre-wrap break-all font-mono">{error}</pre>
        </div>
      )}
    </div>
  )
}
