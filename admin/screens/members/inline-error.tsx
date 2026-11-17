/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useLingui } from '@lingui/react/macro'
import { getAdminErrorMessage } from '../../api/error-messages'

/** A failed admin request's message, where the action was taken. Renders nothing without an error. */
export const InlineError = ({ error }: { error: unknown }) => {
  const { i18n } = useLingui()
  if (!error) {
    return null
  }
  return (
    <p role="alert" className="text-[length:var(--font-size-sm)] text-destructive">
      {i18n._(getAdminErrorMessage(error))}
    </p>
  )
}
