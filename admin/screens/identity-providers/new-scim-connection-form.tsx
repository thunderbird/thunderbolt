/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { FormFooter } from '@/components/ui/form-footer'
import { Input } from '@/components/ui/input'
import { toExpiresAt } from './credential-expiry'
import { ExpiryField } from './expiry-field'
import { FormField } from '../../components/form-field'
import { useAutofocusOnMount } from '@/hooks/use-autofocus-on-mount'
import { IssuedScimToken } from './scim-section'
import { useCreateScimConnection } from './use-connection-queries'
import { InlineError } from '../../components/inline-error'
import { BackOrCancel, backOrCancelFooterClass } from '../../components/back-or-cancel'
import type { PanelDirt } from '../../components/use-resource-page-state'

type NewScimConnectionFormProps = {
  onCreated: (connectionId: string) => void
  onCancel: () => void
  /** Back to the picker this form was opened from; shown in place of Cancel. */
  onBack?: () => void
  onDirty: (dirty: PanelDirt) => void
}

/** A connection that only provisions: its name and first credential, whose token is shown once. */
export const NewScimConnectionForm = ({ onCreated, onCancel, onBack, onDirty }: NewScimConnectionFormProps) => {
  const { t } = useLingui()
  const id = useId()
  const [name, setName] = useState('')
  const nameRef = useAutofocusOnMount<HTMLInputElement>(true)
  const [expiry, setExpiry] = useState('')
  const create = useCreateScimConnection()

  if (create.data) {
    const { connection, credential, token } = create.data
    return (
      <IssuedScimToken
        credential={credential}
        token={token}
        onDone={() => {
          create.reset()
          onDirty(false)
          onCreated(connection.id)
        }}
      />
    )
  }

  return (
    <form
      className="flex flex-1 flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault()
        // The page stays dirty while the token shows, so leaving asks first.
        create.mutate({ name: name.trim(), expiresAt: toExpiresAt(expiry) }, { onSuccess: () => onDirty('secret') })
      }}
    >
      <FormField id={id} label={<Trans>Name</Trans>}>
        <Input
          id={id}
          ref={nameRef}
          value={name}
          required
          onChange={(event) => {
            setName(event.target.value)
            onDirty(true)
          }}
        />
      </FormField>
      <ExpiryField
        value={expiry}
        onChange={(value) => {
          setExpiry(value)
          onDirty(true)
        }}
      />
      <FormFooter className={backOrCancelFooterClass(onBack)}>
        {onBack && <BackOrCancel onBack={onBack} onCancel={onCancel} />}
        <InlineError error={create.error} className="min-w-0 flex-1 truncate" />
        {!onBack && <BackOrCancel onCancel={onCancel} />}
        <Button type="submit" disabled={name.trim() === ''} isLoading={create.isPending} loadingLabel={t`Creating…`}>
          <Trans>Create</Trans>
        </Button>
      </FormFooter>
    </form>
  )
}
