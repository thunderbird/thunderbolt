/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useLingui } from '@lingui/react/macro'
import { useId, type ComponentProps } from 'react'
import { Button } from '@/components/ui/button'
import type { Availability } from './member-rules'

type GuardedActionProps = ComponentProps<typeof Button> & { availability: Availability }

/**
 * A button for an action the API may refuse. When it would, the button is disabled and the reason
 * is shown under it as text, not a tooltip, so it reads the same on touch.
 */
export const GuardedAction = ({ availability, disabled, ...props }: GuardedActionProps) => {
  const { i18n } = useLingui()
  const reasonId = useId()
  const reason = availability.available ? null : availability.reason
  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        {...props}
        disabled={disabled || reason !== null}
        aria-describedby={reason ? reasonId : undefined}
      />
      {reason && (
        <p id={reasonId} className="text-[length:var(--font-size-sm)] text-muted-foreground">
          {i18n._(reason)}
        </p>
      )}
    </div>
  )
}
