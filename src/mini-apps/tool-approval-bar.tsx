/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { ShieldAlert } from 'lucide-react'
import type { PendingToolApproval } from './mini-app-store'

/** Show the arguments as compact JSON, or nothing when the tool takes none. */
const formatArgs = (args: unknown): string | null => {
  if (args === undefined || args === null || (typeof args === 'object' && Object.keys(args).length === 0)) {
    return null
  }
  return JSON.stringify(args, null, 2)
}

type ToolApprovalBarProps = {
  pending: PendingToolApproval
  appName: string
  onDecide: (approved: boolean) => void
}

/**
 * Approval prompt for a Mini App tool that will change something.
 *
 * Deliberately *not* the ACP `PermissionDialog`: that component is shaped around
 * an ACP `requestPermission` (agent id, ACP option ids, allow-always-for-agent),
 * and synthesising those for a non-ACP flow would be coupling wearing reuse's
 * clothes. It mirrors that dialog's visual language instead — same card, same
 * amber shield — so the two read as one idea to the user.
 *
 * Rendered over the app rather than in the chat because the app is what's about
 * to change; the user's attention is already there when they read the diff.
 */
export const ToolApprovalBar = ({ pending, appName, onDecide }: ToolApprovalBarProps) => {
  const { tool, args } = pending
  const label = tool.annotations?.title ?? tool.name
  const formatted = formatArgs(args)

  return (
    <div className="absolute inset-x-0 bottom-0 z-40 border-t bg-card/95 backdrop-blur px-4 py-3" role="dialog">
      <div className="flex items-start gap-3">
        <ShieldAlert className="size-4 text-amber-500 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0 space-y-1">
          <p className="text-[length:var(--font-size-body)] font-medium">
            {appName} wants to run <span className="font-mono">{label}</span>
          </p>
          <p className="text-[length:var(--font-size-sm)] text-muted-foreground">{tool.description}</p>
          {formatted && (
            <pre className="mt-1 max-h-24 overflow-auto rounded-md bg-muted p-2 text-[length:var(--font-size-xs)]">
              {formatted}
            </pre>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button size="sm" variant="outline" onClick={() => onDecide(false)}>
            Deny
          </Button>
          <Button size="sm" onClick={() => onDecide(true)}>
            Approve
          </Button>
        </div>
      </div>
    </div>
  )
}
