/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import type { AdminConnection } from '@shared/admin-api'
import { InlineError } from '../../components/inline-error'
import { useRetireScim } from './use-connection-queries'

/** Confirm retiring a connection's SCIM provisioning. Mounted only while open. */
export const RetireScimDialog = ({
  connection,
  onClose,
}: {
  connection: Pick<AdminConnection, 'id' | 'name'>
  onClose: () => void
}) => {
  const { t } = useLingui()
  const retire = useRetireScim(connection.id)
  const name = connection.name
  return (
    <ConfirmActionDialog
      open
      title={t`Retire SCIM for ${name}?`}
      description={
        <>
          <Trans>Its tokens stop working at once, and people lose the access it gave them. This can't be undone.</Trans>
          <InlineError error={retire.error} />
        </>
      }
      confirmLabel={t`Retire SCIM`}
      isPending={retire.isPending}
      onCancel={onClose}
      onConfirm={() => retire.mutate(undefined, { onSuccess: onClose })}
    />
  )
}
