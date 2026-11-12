/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { ShieldAlert, ShieldCheck } from 'lucide-react'
import type { AgentExecution } from '@/agent-execution/store'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'

/** Shared permission choices for the composer and project settings. */
export const AgentAccessMenuItems = ({ onChange }: { onChange: (access: AgentExecution['access']) => void }) => (
  <>
    <DropdownMenuItem className="cursor-pointer" onSelect={() => onChange('ask')}>
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
    <DropdownMenuItem className="cursor-pointer" variant="destructive" onSelect={() => onChange('full')}>
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
  </>
)
