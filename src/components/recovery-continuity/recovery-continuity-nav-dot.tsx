/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cn } from '@/lib/utils'
import { Trans } from '@lingui/react/macro'
import { useRecoveryContinuity } from './recovery-continuity-provider'

/** Whether Settings should carry the attention marker: the phrase, the passkey, or this device's trust. */
export const useRecoveryContinuityAttention = (): boolean => {
  const { status, passkey } = useRecoveryContinuity()
  return status !== 'hidden' || passkey === 'needsUpdate' || passkey === 'blocked'
}

/**
 * The warning-colored dot on Settings while continuity needs attention. The dot
 * is hidden from assistive tech and the sr-only text joins the control's name,
 * so a control named by `aria-label` must say it there instead.
 */
export const RecoveryContinuityNavDot = ({ placement }: { placement: 'corner' | 'trailing' }) => {
  const attention = useRecoveryContinuityAttention()
  if (!attention) {
    return null
  }
  return (
    <>
      <span
        aria-hidden
        className={cn(
          'pointer-events-none size-2 shrink-0 rounded-full bg-warning',
          placement === 'corner'
            ? 'absolute right-1 top-1 z-20 ring-2 ring-background'
            : 'ml-auto group-data-[collapsible=icon]:absolute group-data-[collapsible=icon]:right-1 group-data-[collapsible=icon]:top-1',
        )}
      />
      <span className="sr-only">
        <Trans>Action needed</Trans>
      </span>
    </>
  )
}
