/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useLingui } from '@lingui/react/macro'
import { AdminPage } from '../../components/admin-page'

export const DomainsPage = () => {
  const { t } = useLingui()
  return <AdminPage title={t`Domains`} />
}
