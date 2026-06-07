/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { TinfoilVerification } from '@/hooks/use-tinfoil-verification'
import { cn } from '@/lib/utils'
import { Loader2, Lock, Unlock } from 'lucide-react'
import { type ComponentType } from 'react'

type ChipState = {
  label: string
  tooltip: string
  Icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
  className: string
  iconClassName?: string
}

// Three states mirror tinfoil-webapp's verification button: closed lock /
// spinner / open lock.
const chipStateByStatus: Record<'verifying' | 'verified' | 'failed', ChipState> = {
  verifying: {
    label: 'Verifying…',
    tooltip: 'Verifying the confidential enclave running this model — click to watch progress.',
    Icon: Loader2,
    className: 'text-muted-foreground',
    iconClassName: 'animate-spin',
  },
  verified: {
    label: 'Verified',
    tooltip: 'This conversation is verified end-to-end to a genuine Tinfoil enclave. Click to inspect the proof.',
    Icon: Lock,
    className: 'text-green-600 dark:text-green-500',
  },
  failed: {
    label: 'Verification failed',
    tooltip: 'Enclave verification failed — sending is blocked. Click for details and to retry.',
    Icon: Unlock,
    className: 'text-destructive',
  },
}

type VerificationStatusChipProps = {
  verification: TinfoilVerification
  onOpen: () => void
}

/**
 * Clickable enclave-verification indicator shown next to the composer model
 * picker for Tinfoil-provider models. Renders nothing (`status === 'idle'`) for
 * every other model. Opens the Verification Center drawer on click.
 */
export const VerificationStatusChip = ({ verification, onOpen }: VerificationStatusChipProps) => {
  if (verification.status === 'idle') {
    return null
  }

  const { label, tooltip, Icon, className, iconClassName } = chipStateByStatus[verification.status]

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onOpen}
            aria-label={`${label} — open Verification Center`}
            className={cn(
              'inline-flex items-center gap-1.5 h-[var(--touch-height-default)] rounded-lg border border-border px-3 font-medium text-[length:var(--font-size-body)] transition-colors hover:bg-accent/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              className,
            )}
          >
            <Icon className={cn('size-3.5 shrink-0', iconClassName)} aria-hidden={true} />
            <span className="hidden sm:inline">{label}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
