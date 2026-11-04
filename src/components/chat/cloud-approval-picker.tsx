/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { ShieldAlert, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

/** Each explicit message captures this chat's approval choice; reopening defaults to asking. */
export const CloudApprovalPicker = ({
  disabled,
  value,
  onChange,
  open,
  onOpenChange,
  side = 'top',
}: {
  side?: 'top' | 'bottom'
  disabled: boolean
  value: 'ask' | 'full-access'
  onChange: (value: 'ask' | 'full-access') => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) => {
  const { t } = useLingui()
  const hasFullAccess = value === 'full-access'
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={disabled}
          aria-label={t`Tool approvals`}
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
      <DropdownMenuContent align="start" side={side}>
        <DropdownMenuRadioGroup
          className="flex flex-col gap-0.5"
          value={value}
          onValueChange={(next) => {
            if (next === 'ask' || next === 'full-access') {
              onChange(next)
            }
          }}
        >
          <DropdownMenuRadioItem value="ask" showIndicator={false} className="cursor-pointer">
            <ShieldCheck />
            <Trans>Ask for approval</Trans>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem
            value="full-access"
            showIndicator={false}
            className="cursor-pointer text-destructive focus:bg-destructive/10 focus:text-destructive data-[state=checked]:bg-destructive/10 [&_svg]:text-destructive"
          >
            <ShieldAlert />
            <Trans>Full access</Trans>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
