/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState, useTransition } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { invoke } from '@tauri-apps/api/core'
import { Box, ChevronDown, Cloud, Monitor } from 'lucide-react'
import type { AgentExecution } from '@/agent-execution/store'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { isTauriDesktop } from '@/lib/platform'

/** Environment selection is available only while creating the project. */
export const ProjectExecutionField = ({
  execution,
  onChange,
  disabled,
}: {
  execution: AgentExecution
  onChange: (execution: AgentExecution) => void
  disabled: boolean
}) => {
  const { t } = useLingui()
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const computer = execution.location === 'computer'
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
              {computer ? <Monitor className="size-4" /> : <Box className="size-4" />}
              {computer ? <Trans>This computer</Trans> : <Trans>Local sandbox</Trans>}
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
          <DropdownMenuItem disabled>
            <Cloud />
            <Trans>Cloud — coming soon</Trans>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {computer && <p className="break-all text-xs text-muted-foreground">{execution.cwd}</p>}
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
