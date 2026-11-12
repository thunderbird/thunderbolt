/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useId } from 'react'
import { Trans } from '@lingui/react/macro'
import { ChevronDown, ShieldAlert, ShieldCheck } from 'lucide-react'
import type { AgentExecution } from '@/agent-execution/store'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { AgentAccessMenuItems } from './agent-access-menu-items'

/** A labeled version of the composer's access control for project forms. */
export const AgentAccessField = ({
  access,
  onChange,
  disabled = false,
}: {
  access: AgentExecution['access']
  onChange: (access: AgentExecution['access']) => void
  disabled?: boolean
}) => {
  const id = useId()
  const Icon = access === 'full' ? ShieldAlert : ShieldCheck
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>
        <Trans>Agent permissions</Trans>
      </Label>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button id={id} type="button" variant="outline" className="w-full justify-between" disabled={disabled}>
            <span className="flex items-center gap-2">
              <Icon className="size-4" />
              {access === 'full' ? <Trans>Full access</Trans> : <Trans>Ask for approval</Trans>}
            </span>
            <ChevronDown className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <AgentAccessMenuItems onChange={onChange} />
        </DropdownMenuContent>
      </DropdownMenu>
      <p className="text-xs text-muted-foreground">
        <Trans>Applies to all chats in this project on this device.</Trans>
      </p>
    </div>
  )
}
