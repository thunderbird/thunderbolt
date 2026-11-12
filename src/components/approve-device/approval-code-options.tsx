/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Button } from '@/components/ui/button'
import { Loader2 } from 'lucide-react'

type ApprovalCodeOptionsProps = {
  /** Null while the new device has not revealed yet: the grid keeps its shape so nothing jumps. */
  options: string[] | null
  onPick: (option: string) => void
  disabled: boolean
  pendingOption: string | null
}

const placeholderSlots = ['a', 'b', 'c', 'd', 'e', 'f']

/** Six two-digit codes in two rows of three, set the same way the new device shows its code. */
export const ApprovalCodeOptions = ({ options, onPick, disabled, pendingOption }: ApprovalCodeOptionsProps) => {
  const { t } = useLingui()
  if (!options) {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-2" aria-hidden>
          {placeholderSlots.map((slot) => (
            <div key={slot} className="h-[var(--touch-height-xl)] rounded-lg bg-muted motion-safe:animate-pulse" />
          ))}
        </div>
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          <Trans>Connecting to the new device…</Trans>
        </p>
      </div>
    )
  }
  return (
    <div role="group" aria-label={t`Codes to choose from`} className="grid grid-cols-3 gap-2">
      {options.map((option) => (
        <Button
          key={option}
          variant="outline"
          className="h-[var(--touch-height-xl)] text-3xl font-semibold tabular-nums tracking-wide"
          onClick={() => onPick(option)}
          disabled={disabled}
          isLoading={pendingOption === option}
        >
          {option}
        </Button>
      ))}
    </div>
  )
}
