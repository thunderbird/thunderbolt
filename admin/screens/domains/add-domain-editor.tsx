/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useId, useState } from 'react'
import { DetailPanel } from '@/components/detail-panel'
import { Button } from '@/components/ui/button'
import { FormFooter } from '@/components/ui/form-footer'
import { Input } from '@/components/ui/input'
import type { OrgDomain } from '@shared/admin-api'
import { getAdminErrorMessage } from '../../api/error-messages'
import { useAddDomain } from './use-domains'
import { describedBy, FormField } from '../../components/form-field'
import { useAutofocusOnMount } from '@/hooks/use-autofocus-on-mount'
import { BackOrCancel, backOrCancelFooterClass } from '../../components/back-or-cancel'

type AddDomainEditorProps = {
  onAdded: (domain: OrgDomain) => void
  onDirtyChange: (dirty: boolean) => void
  onClose: () => void
  /** Back to the "add" picker it was opened from; shown in place of Cancel. */
  onBack?: () => void
}

export const AddDomainEditor = ({ onAdded, onDirtyChange, onClose, onBack }: AddDomainEditorProps) => {
  const { t, i18n } = useLingui()
  const inputId = useId()
  const inputRef = useAutofocusOnMount<HTMLInputElement>(true)
  const [domain, setDomain] = useState('')
  const add = useAddDomain()

  return (
    <DetailPanel title={t`Add Domain`} onClose={onClose}>
      <form
        className="flex flex-1 flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault()
          add.mutate(domain.trim(), { onSuccess: (added) => onAdded(added) })
        }}
      >
        <FormField
          id={inputId}
          label={<Trans>Domain</Trans>}
          tooltip={<Trans>Subdomains aren't included. Add each one separately.</Trans>}
          error={add.error ? i18n._(getAdminErrorMessage(add.error)) : undefined}
        >
          <Input
            id={inputId}
            ref={inputRef}
            value={domain}
            required
            autoComplete="off"
            placeholder={t`example.com`}
            aria-describedby={describedBy(inputId, { error: add.error ? true : undefined })}
            aria-invalid={add.error ? true : undefined}
            onChange={(event) => {
              setDomain(event.target.value)
              onDirtyChange(event.target.value.trim() !== '')
            }}
            className="md:h-9"
          />
        </FormField>
        <FormFooter className={backOrCancelFooterClass(onBack)}>
          <BackOrCancel onBack={onBack} onCancel={onClose} />
          <Button type="submit" disabled={domain.trim() === ''} isLoading={add.isPending} loadingLabel={t`Adding…`}>
            <Trans>Add</Trans>
          </Button>
        </FormFooter>
      </form>
    </DetailPanel>
  )
}
