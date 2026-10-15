/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Box, Cloud, Monitor, ShieldCheck, ShieldAlert } from 'lucide-react'
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
import { cn } from '@/lib/utils'

/** Execution location and permission mode for the built-in agent. */
export const AgentExecutionControls = ({ threadId, disabled }: { threadId: string; disabled: boolean }) => {
  const { t } = useLingui()
  const state = useAgentExecutionControlsState(threadId)
  const { execution, setExecution } = state
  const computer = execution.location === 'computer'
  const full = execution.access === 'full'
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
            title={computer ? t`This computer` : t`Local sandbox`}
            className="size-[var(--touch-height-control)] rounded-[var(--radius-control)] text-muted-foreground hover:bg-accent/50 hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
          >
            {computer ? (
              <Monitor className="size-[var(--icon-size-default)]" />
            ) : (
              <Box className="size-[var(--icon-size-default)]" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-72">
          {state.desktop && (
            <DropdownMenuItem className="cursor-pointer" onSelect={state.openFolder}>
              <Monitor />
              <div>
                <div>
                  <Trans>This computer</Trans>
                </div>
                <p className="break-all text-muted-foreground text-[length:var(--font-size-xs)]">
                  {computer ? execution.cwd : <Trans>Real files and commands on your computer</Trans>}
                </p>
              </div>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            className="cursor-pointer"
            onSelect={() => setExecution({ ...execution, location: 'sandbox' })}
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
          <DropdownMenuSeparator />
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
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={disabled || state.pending}
            aria-label={t`Agent access`}
            title={full ? t`Full access` : t`Ask for approval`}
            className={cn(
              'size-[var(--touch-height-control)] rounded-[var(--radius-control)] text-muted-foreground hover:bg-accent/50 hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground',
              full && 'text-destructive hover:text-destructive data-[state=open]:text-destructive',
            )}
          >
            {full ? (
              <ShieldAlert className="size-[var(--icon-size-default)]" />
            ) : (
              <ShieldCheck className="size-[var(--icon-size-default)]" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-72">
          <DropdownMenuItem className="cursor-pointer" onSelect={() => setExecution({ ...execution, access: 'ask' })}>
            <ShieldCheck />
            <div>
              <div>
                <Trans>Ask for approval</Trans>
              </div>
              <p className="text-muted-foreground text-[length:var(--font-size-xs)]">
                <Trans>Ask before changes, commands, and external actions</Trans>
              </p>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem
            className="cursor-pointer"
            variant="destructive"
            onSelect={() => setExecution({ ...execution, access: 'full' })}
          >
            <ShieldAlert />
            <div>
              <div>
                <Trans>Full access</Trans>
              </div>
              <p className="text-[length:var(--font-size-xs)]">
                <Trans>Allow tools to act without asking</Trans>
              </p>
            </div>
          </DropdownMenuItem>
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
