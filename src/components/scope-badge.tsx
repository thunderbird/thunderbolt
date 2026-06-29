/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Lock, Users } from 'lucide-react'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { ResourceScope } from '@/components/scope-picker'

export type ScopeBadgeProps = {
  /** Row's `scope` value. `'workspace'` or `null`/`undefined` renders the
   *  "Shared" variant (the default); `'user'` renders "Private". */
  scope: ResourceScope | null | undefined
  /** Gate the badge on the caller's visibility decision — typically
   *  `useScopePickerEnabled()` resolved once at the page level and threaded
   *  down. When `false` the component renders nothing. Required so this
   *  component stays purely visual (no hook → no provider dependency in
   *  component-level tests). */
  show: boolean
  /** Extra classes appended to the badge `<span>`. Use for margins / sizing
   *  tweaks per consumer; the base look stays consistent. */
  className?: string
}

/**
 * Inline pill that surfaces a workspace-resource's `scope` (`workspace` vs
 * `user`). Hides itself when `show` is false — the distinction is meaningless
 * in a personal workspace or when the deployment flag is off, so callers gate
 * it on `useScopePickerEnabled()`.
 *
 * Visual: muted bg, xs text, icon + label. Matches the models page badge (the
 * original implementation site) so every resource list looks the same.
 */
export const ScopeBadge = ({ scope, show, className }: ScopeBadgeProps) => {
  if (!show) {
    return null
  }
  const isPrivate = scope === 'user'
  const Icon = isPrivate ? Lock : Users
  const label = isPrivate ? 'Private' : 'Shared'
  const tooltip = isPrivate ? 'Only visible to you in this workspace.' : 'Shared with everyone in this workspace.'
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={`inline-flex w-fit items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground${
              className ? ` ${className}` : ''
            }`}
          >
            <Icon className="size-3" />
            {label}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>{tooltip}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
