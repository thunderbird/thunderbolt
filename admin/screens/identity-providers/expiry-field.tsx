/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans } from '@lingui/react/macro'
import { useId } from 'react'
import { DateField } from '../../components/date-field'
import { todayDateInput } from './credential-expiry'
import { FormField } from '../../components/form-field'

/** The optional expiry date of a new SCIM credential. */
export const ExpiryField = ({ value, onChange }: { value: string; onChange: (value: string) => void }) => {
  const id = useId()
  return (
    <FormField id={id} label={<Trans>Expires on</Trans>}>
      <DateField
        id={id}
        min={todayDateInput()}
        value={value}
        placeholder={<Trans>Pick a date</Trans>}
        onChange={onChange}
      />
    </FormField>
  )
}
