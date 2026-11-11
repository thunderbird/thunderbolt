/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState, useTransition } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { invoke } from '@tauri-apps/api/core'
import { Box, ChevronDown, Cloud, Monitor, Server } from 'lucide-react'
import type { AgentExecution } from '@/agent-execution/store'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useSshEnvironmentsStore } from '@/agent-execution/ssh-environments'
import { SshEnvironmentMenuItem, SshEnvironmentStatus, SshFolderInput } from '@/components/ssh-environments'
import { Link } from 'react-router'
import { isTauriDesktop } from '@/lib/platform'

/** Environment selection is available only while creating the project. */
export const ProjectExecutionField = ({
  execution,
  onChange,
  disabled,
  onManageEnvironments,
}: {
  execution: AgentExecution
  onChange: (execution: AgentExecution) => void
  disabled: boolean
  onManageEnvironments?: () => void
}) => {
  const { t } = useLingui()
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const computer = execution.location === 'computer'
  const environments = useSshEnvironmentsStore((state) => state.environments)
  const sshEnvironment = execution.location === 'ssh' ? environments[execution.environmentId] : undefined
  const selectComputer = () =>
    startTransition(async () => {
      setError(null)
      try {
        const cwd = await invoke<string | null>('agent_pick_workspace', {
          path: computer ? execution.cwd : null,
          title: t`Choose project folder`,
        })
        if (cwd !== null) {
          onChange({ location: 'computer', cwd, access: execution.access })
        }
      } catch (cause) {
        console.error('[projects] Could not select project folder', cause)
        setError(t`Could not select a working folder. Please try again.`)
      }
    })
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">
        <Trans>Agent environment</Trans>
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="w-full justify-between"
            aria-label={t`Project environment`}
            disabled={disabled || pending}
          >
            <span className="flex items-center gap-2">
              {execution.location === 'ssh' ? (
                <Server className="size-4" />
              ) : computer ? (
                <Monitor className="size-4" />
              ) : (
                <Box className="size-4" />
              )}
              {execution.location === 'ssh' ? (
                (sshEnvironment?.name ?? t`SSH environment unavailable`)
              ) : computer ? (
                <Trans>This computer</Trans>
              ) : (
                <Trans>Local sandbox</Trans>
              )}
              {execution.location === 'ssh' && <SshEnvironmentStatus environmentId={execution.environmentId} />}
            </span>
            <ChevronDown className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuItem
            onSelect={() => {
              setError(null)
              onChange({ location: 'sandbox', access: execution.access })
            }}
          >
            <Box />
            <Trans>Local sandbox</Trans>
          </DropdownMenuItem>
          {isTauriDesktop() && (
            <DropdownMenuItem onSelect={selectComputer}>
              <Monitor />
              <Trans>This computer</Trans>
            </DropdownMenuItem>
          )}
          {isTauriDesktop() &&
            Object.values(environments)
              .filter((environment) => !environment.deletedAt)
              .map((environment) => (
                <SshEnvironmentMenuItem
                  key={environment.id}
                  environment={environment}
                  onSelect={() => {
                    setError(null)
                    onChange({
                      location: 'ssh',
                      environmentId: environment.id,
                      cwd: environment.cwd,
                      access: execution.access,
                    })
                  }}
                />
              ))}
          {isTauriDesktop() && (
            <DropdownMenuItem asChild>
              <Link to="/settings/environments" onClick={onManageEnvironments}>
                <Server />
                <Trans>Manage SSH environments</Trans>
              </Link>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem disabled>
            <Cloud />
            <Trans>Cloud — coming soon</Trans>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {computer && <p className="break-all text-xs text-muted-foreground">{execution.cwd}</p>}
      {execution.location === 'ssh' && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="project-ssh-working-folder">
            <Trans>Remote working folder</Trans>
          </Label>
          <SshFolderInput
            id="project-ssh-working-folder"
            environmentId={execution.environmentId}
            value={execution.cwd}
            onChange={(cwd) => onChange({ ...execution, cwd })}
            disabled={disabled || pending}
          />
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        <Trans>Every chat in this project uses this environment. It cannot be changed after creation.</Trans>
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
