/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useLingui } from '@lingui/react/macro'
import { cn } from '@/lib/utils'
import { getAdminErrorMessage } from '../api/error-messages'

/**
 * A failed admin request's message, where the action was taken. Renders nothing without an error.
 * A block `span`, so it also fits inside a dialog description.
 */
export const InlineError = ({ error, className }: { error: unknown; className?: string }) => {
  const { i18n } = useLingui()
  if (!error) {
    return null
  }
  return (
    <span role="alert" className={cn('block text-[length:var(--font-size-sm)] text-destructive', className)}>
      {i18n._(getAdminErrorMessage(error))}
    </span>
  )
}
