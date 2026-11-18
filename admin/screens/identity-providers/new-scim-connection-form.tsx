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
import { describedBy, FormField } from './form-field'
import { IssuedScimToken } from './scim-section'
import { useCreateScimConnection } from './use-connection-queries'
import { InlineError } from '../../components/inline-error'

type NewScimConnectionFormProps = {
  onCreated: (connectionId: string) => void
  onCancel: () => void
  onDirty: (dirty: boolean) => void
}

/** A connection that only provisions: its name and first credential, whose token is shown once. */
export const NewScimConnectionForm = ({ onCreated, onCancel, onDirty }: NewScimConnectionFormProps) => {
  const { t } = useLingui()
  const id = useId()
  const [name, setName] = useState('')
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

  const hint = t`Your identity provider's name for this tenant or realm. It can't be renamed later.`
  return (
    <form
      className="flex flex-1 flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault()
        // The page stays dirty while the token shows, so leaving asks first.
        create.mutate({ name: name.trim(), expiresAt: toExpiresAt(expiry) }, { onSuccess: () => onDirty(true) })
      }}
    >
      <FormField id={id} label={<Trans>Name</Trans>} hint={hint}>
        <Input
          id={id}
          value={name}
          required
          aria-describedby={describedBy(id, { hint })}
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
      <InlineError error={create.error} />
      <FormFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isLoading={create.isPending}>
          <Trans>Create connection</Trans>
        </Button>
      </FormFooter>
    </form>
  )
}
