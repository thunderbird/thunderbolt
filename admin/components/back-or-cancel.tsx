/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { BackButton } from '@/components/ui/back-button'
import { ResponsiveModalCancel } from '@/components/ui/responsive-modal'

/**
 * A form footer's leading action, as the Connections forms place it: Back to the picker when the form
 * was reached from one, Cancel otherwise. Give the `FormFooter` `backOrCancelFooterClass` with it.
 */
export const BackOrCancel = ({ onBack, onCancel }: { onBack?: () => void; onCancel: () => void }) =>
  onBack ? (
    <BackButton onClick={onBack} />
  ) : (
    <ResponsiveModalCancel onClick={onCancel} className="dark:hover:bg-accent" />
  )

/** The `FormFooter` layout for `BackOrCancel`: Back sits apart, on the left. */
export const backOrCancelFooterClass = (onBack?: () => void) => (onBack ? 'items-center justify-between' : undefined)
