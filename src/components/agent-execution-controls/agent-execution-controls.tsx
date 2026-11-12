/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Box, Cloud, Monitor, Server, ShieldCheck, ShieldAlert } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { useAgentExecutionControlsState } from './use-agent-execution-controls-state'
import { useProjectExecutionControlsState } from './use-project-execution-controls-state'
import { cn } from '@/lib/utils'
import { useSshEnvironmentsStore } from '@/agent-execution/ssh-environments'
import { SshEnvironmentMenuItem, SshEnvironmentStatus } from '@/components/ssh-environments'
import { Link } from 'react-router'
import { AgentAccessMenuItems } from './agent-access-menu-items'

type AgentExecutionControlsProps = { threadId: string; projectId?: string | null; disabled: boolean }

/** Standalone chats choose a runtime; project chats inherit their creation-time choice. */
export const AgentExecutionControls = ({ threadId, projectId, disabled }: AgentExecutionControlsProps) =>
  projectId ? (
    <ProjectExecutionControls projectId={projectId} disabled={disabled} />
  ) : (
    <ThreadExecutionControls threadId={threadId} disabled={disabled} />
  )

const ThreadExecutionControls = ({ threadId, disabled }: AgentExecutionControlsProps) => {
  const state = useAgentExecutionControlsState(threadId)
  return <AgentExecutionControlsView state={state} disabled={disabled} />
}

const ProjectExecutionControls = ({ projectId, disabled }: { projectId: string; disabled: boolean }) => {
  const state = useProjectExecutionControlsState(projectId)
  return <AgentExecutionControlsView state={state} disabled={disabled} />
}

const AgentExecutionControlsView = ({
  state,
  disabled,
}: {
  state: ReturnType<typeof useAgentExecutionControlsState>
  disabled: boolean
}) => {
  const { t } = useLingui()
  const { execution, setExecution } = state
  const isComputer = execution.location === 'computer'
  const environments = useSshEnvironmentsStore((store) => store.environments)
  const sshEnvironment = execution.location === 'ssh' ? environments[execution.environmentId] : undefined
  const locationLabel =
    execution.location === 'ssh'
      ? (sshEnvironment?.name ?? t`SSH environment unavailable`)
      : isComputer
        ? t`This computer`
        : execution.location === 'cloud'
          ? t`Cloud`
          : t`Local sandbox`
  const LocationIcon =
    execution.location === 'ssh' ? Server : isComputer ? Monitor : execution.location === 'cloud' ? Cloud : Box
  const hasFullAccess = execution.access === 'full'
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={disabled || state.pending}
            aria-label={t`Agent location`}
            title={locationLabel}
            className="size-[var(--touch-height-control)] rounded-[var(--radius-control)] text-muted-foreground hover:bg-accent/50 hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
          >
            <span className="relative">
              <LocationIcon className="size-[var(--icon-size-default)]" />
              {execution.location === 'ssh' && (
                <span className="absolute -bottom-1 -right-1">
                  <SshEnvironmentStatus environmentId={execution.environmentId} />
                </span>
              )}
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-72">
          {state.locationLocked && (
            <DropdownMenuItem disabled>
              <LocationIcon />
              <div>
                <div>{locationLabel}</div>
                {(isComputer || execution.location === 'ssh') && execution.cwd && (
                  <p className="break-all text-muted-foreground text-xs">{execution.cwd}</p>
                )}
              </div>
            </DropdownMenuItem>
          )}
          {state.locationLocked && isComputer && !state.available && state.desktop && (
            <DropdownMenuItem onSelect={state.openFolder}>
              <Monitor />
              <Trans>Choose project folder on this computer</Trans>
            </DropdownMenuItem>
          )}
          {!state.locationLocked && state.desktop && (
            <DropdownMenuItem className="cursor-pointer" onSelect={state.openFolder}>
              <Monitor />
              <div>
                <div>
                  <Trans>This computer</Trans>
                </div>
                <p className="break-all text-muted-foreground text-[length:var(--font-size-xs)]">
                  {isComputer ? execution.cwd : <Trans>Real files and commands on your computer</Trans>}
                </p>
              </div>
            </DropdownMenuItem>
          )}
          {!state.locationLocked && (
            <DropdownMenuItem
              className="cursor-pointer"
              onSelect={() => setExecution({ location: 'sandbox', access: execution.access })}
            >
              <Box />
              <div>
                <div>
                  <Trans>Local sandbox</Trans>
                </div>
                <p className="text-muted-foreground text-[length:var(--font-size-xs)]">
                  <Trans>Private workspace inside Thunderbolt</Trans>
                </p>
              </div>
            </DropdownMenuItem>
          )}
          {!state.locationLocked &&
            state.desktop &&
            Object.values(environments)
              .filter((environment) => !environment.deletedAt)
              .map((environment) => (
                <SshEnvironmentMenuItem
                  key={environment.id}
                  environment={environment}
                  onSelect={() =>
                    setExecution({
                      location: 'ssh',
                      environmentId: environment.id,
                      cwd: environment.cwd,
                      access: execution.access,
                    })
                  }
                />
              ))}
          {state.desktop && (
            <DropdownMenuItem asChild>
              <Link to="/settings/environments">
                <Server />
                <Trans>Manage SSH environments</Trans>
              </Link>
            </DropdownMenuItem>
          )}
          {!state.locationLocked && <DropdownMenuSeparator />}
          {!state.locationLocked && (
            <DropdownMenuItem disabled>
              <Cloud />
              <div>
                <div>
                  <Trans>Cloud</Trans>
                </div>
                <p className="text-muted-foreground text-[length:var(--font-size-xs)]">
                  <Trans>Coming soon</Trans>
                </p>
              </div>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={disabled || state.pending || !state.available}
            aria-label={t`Agent access`}
            title={hasFullAccess ? t`Full access` : t`Ask for approval`}
            className={cn(
              'size-[var(--touch-height-control)] rounded-[var(--radius-control)] text-muted-foreground hover:bg-accent/50 hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground',
              hasFullAccess && 'text-destructive hover:text-destructive data-[state=open]:text-destructive',
            )}
          >
            {hasFullAccess ? (
              <ShieldAlert className="size-[var(--icon-size-default)]" />
            ) : (
              <ShieldCheck className="size-[var(--icon-size-default)]" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-72">
          <AgentAccessMenuItems onChange={(access) => setExecution({ ...execution, access })} />
        </DropdownMenuContent>
      </DropdownMenu>
      {state.error && (
        <span role="alert" className="text-destructive text-[length:var(--font-size-xs)]">
          {state.error}
        </span>
      )}
    </>
  )
}
