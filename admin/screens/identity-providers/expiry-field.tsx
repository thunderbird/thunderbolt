/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useId } from 'react'
import { DateField } from '../../components/date-field'
import { todayDateInput } from './credential-expiry'
import { describedBy, FormField } from './form-field'

/** The optional expiry date of a new SCIM credential. */
export const ExpiryField = ({ value, onChange }: { value: string; onChange: (value: string) => void }) => {
  const { t } = useLingui()
  const id = useId()
  const hint = t`Optional. It stops working at the end of that day. Without a date, it expires in a year.`
  return (
    <FormField id={id} label={<Trans>Credential expires on</Trans>} hint={hint}>
      <DateField
        id={id}
        min={todayDateInput()}
        value={value}
        placeholder={<Trans>Pick a date</Trans>}
        aria-describedby={describedBy(id, { hint })}
        onChange={onChange}
      />
    </FormField>
  )
}
