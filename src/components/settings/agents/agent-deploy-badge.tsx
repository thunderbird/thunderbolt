/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'

import { useDeploymentStatus } from '@/components/agents/use-deployment-status'
import { cn } from '@/lib/utils'
import type { Agent } from '@/types/acp'

/**
 * A "· label" status chip appended to the provenance line. The leading separator
 * inherits the muted subtitle color like every other "·"; only the label carries
 * the state color. It's a single flex box so it centers as one unit within the
 * subtitle's flex row, staying intact (`shrink-0`) while the provenance text
 * truncates.
 */
const StatusChip = ({ className, children }: { className?: string; children: ReactNode }) => (
  <span className="flex shrink-0 items-center gap-1">
    <span aria-hidden="true">·</span>
    <span className={cn('flex items-center gap-1', className)}>{children}</span>
  </span>
)

/**
 * Live deploy status for a managed agent, appended to its provenance line.
 * Renders nothing while the agent is usable (`running`) — the row then reads as a
 * normal agent. It surfaces the transient spin-up ("Deploying…") and the two
 * states that warrant a warning: a failed deploy ("Deploy failed") and a
 * deleted/undeployed pipeline ("Unavailable"). Only mount it for managed agents;
 * others carry no deployment.
 */
export const AgentDeployBadge = ({ agent }: { agent: Agent }) => {
  const status = useDeploymentStatus(agent)

  if (status === 'pending') {
    return (
      <StatusChip className="text-muted-foreground">
        <Loader2 className="size-3 animate-spin" aria-hidden="true" />
        Deploying…
      </StatusChip>
    )
  }

  if (status === 'failed') {
    return <StatusChip className="font-medium text-destructive">Deploy failed</StatusChip>
  }

  if (status === 'gone') {
    return <StatusChip className="font-medium text-destructive">Unavailable</StatusChip>
  }

  return null
}
