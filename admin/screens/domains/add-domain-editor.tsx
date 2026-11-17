/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useId, useState } from 'react'
import { DetailPanel } from '@/components/detail-panel'
import { DetailField } from '@/components/settings/detail-field'
import { Button } from '@/components/ui/button'
import { FormFooter } from '@/components/ui/form-footer'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { OrgDomain } from '@shared/admin-api'
import { getAdminErrorMessage } from '../../api/error-messages'
import { useAddDomain } from './use-domains'

type AddDomainEditorProps = {
  onAdded: (domain: OrgDomain) => void
  onDirtyChange: (dirty: boolean) => void
  onClose: () => void
}

export const AddDomainEditor = ({ onAdded, onDirtyChange, onClose }: AddDomainEditorProps) => {
  const { t, i18n } = useLingui()
  const inputId = useId()
  const hintId = useId()
  const errorId = useId()
  const [domain, setDomain] = useState('')
  const add = useAddDomain()

  return (
    <DetailPanel title={t`Add domain`} onClose={onClose}>
      <form
        className="flex flex-1 flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault()
          add.mutate(domain.trim(), { onSuccess: (added) => onAdded(added) })
        }}
      >
        <DetailField
          label={
            <Label htmlFor={inputId}>
              <Trans>Domain</Trans>
            </Label>
          }
        >
          <Input
            id={inputId}
            value={domain}
            required
            autoComplete="off"
            placeholder={t`example.com`}
            aria-describedby={add.error ? `${hintId} ${errorId}` : hintId}
            aria-invalid={add.error ? true : undefined}
            onChange={(event) => {
              setDomain(event.target.value)
              onDirtyChange(event.target.value.trim() !== '')
            }}
          />
          <p id={hintId} className="text-[length:var(--font-size-sm)] text-muted-foreground">
            <Trans>Add each subdomain on its own: a domain never covers its subdomains.</Trans>
          </p>
          {add.error && (
            <p id={errorId} role="alert" className="text-[length:var(--font-size-sm)] text-destructive">
              {i18n._(getAdminErrorMessage(add.error))}
            </p>
          )}
        </DetailField>
        <FormFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" disabled={add.isPending || domain.trim() === ''}>
            {add.isPending ? <Trans>Adding…</Trans> : <Trans>Add domain</Trans>}
          </Button>
        </FormFooter>
      </form>
    </DetailPanel>
  )
}
