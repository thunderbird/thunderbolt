/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Box, Cloud } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/** A chat pins the runtime on its first message, while its agent definition remains portable. */
export const AgentEnvironmentPicker = ({
  value,
  locked,
  disabled,
  onChange,
  open,
  onOpenChange,
  side = 'top',
}: {
  side?: 'top' | 'bottom'
  open?: boolean
  onOpenChange?: (open: boolean) => void
  value: 'local' | 'cloud'
  locked: boolean
  disabled: boolean
  onChange: (environment: 'local' | 'cloud') => void
}) => {
  const { t } = useLingui()
  const Icon = value === 'local' ? Box : Cloud
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={disabled || locked}
          aria-label={t`Execution environment`}
          aria-description={locked ? t`Start a new chat to choose another environment.` : undefined}
          title={value === 'local' ? t`This device` : t`Cloud`}
          className="size-[var(--touch-height-control)] rounded-[var(--radius-control)] text-muted-foreground hover:bg-accent/50 hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
        >
          <Icon className="size-[var(--icon-size-default)]" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side={side}>
        <DropdownMenuRadioGroup
          className="flex flex-col gap-0.5"
          value={value}
          onValueChange={(next) => {
            if (next === 'local' || next === 'cloud') {
              onChange(next)
            }
          }}
        >
          <DropdownMenuRadioItem value="local" showIndicator={false} className="cursor-pointer">
            <Box />
            <Trans>This device</Trans>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="cloud" showIndicator={false} className="cursor-pointer">
            <Cloud />
            <Trans>Cloud</Trans>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
