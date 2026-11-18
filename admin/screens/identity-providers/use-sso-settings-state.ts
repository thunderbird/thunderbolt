/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useQueryClient } from '@tanstack/react-query'
import { useReducer, type FormEvent } from 'react'
import type { AdminConnectionDetail, SsoLockableField, UpdateSsoConnectionBody } from '@shared/admin-api'
import { adminQueryKeys } from '../../api/query-keys'
import { toSsoFieldError } from './sso-field-errors'
import { useUpdateSsoConnection } from './use-connection-queries'

export type SsoSettingsDraft = {
  name: string
  clientId: string
  discoveryEndpoint: string
  entryPoint: string
  matchClaim: string
  /** Replace-only: blank keeps the stored secret, which is never read back. */
  clientSecret: string
  /** Replace-only, like the secret. */
  cert: string
}

export type SsoSettingsField = keyof SsoSettingsDraft

/** An edit form for a connection that has an SSO side. */
export type SsoConnectionDetail = AdminConnectionDetail & { sso: NonNullable<AdminConnectionDetail['sso']> }

/** The form as the connection stands: its settings prefilled, the secret and certificate blank. */
export const initialSsoSettingsDraft = ({ name, matchClaim, sso }: SsoConnectionDetail): SsoSettingsDraft => ({
  name,
  matchClaim,
  clientId: sso.protocol === 'oidc' ? sso.clientId : '',
  discoveryEndpoint: sso.protocol === 'oidc' ? (sso.discoveryEndpoint ?? '') : '',
  entryPoint: sso.protocol === 'saml' ? sso.entryPoint : '',
  clientSecret: '',
  cert: '',
})

const isLockable = (field: SsoSettingsField): field is SsoLockableField =>
  field === 'clientId' || field === 'discoveryEndpoint' || field === 'entryPoint' || field === 'matchClaim'

/** Whether the server would refuse to change `field` right now. */
export const isSsoFieldLocked = (detail: Pick<AdminConnectionDetail, 'lockedFields'>, field: SsoSettingsField) =>
  isLockable(field) && detail.lockedFields.includes(field)

/**
 * The PATCH body: only what changed. A blank field is unchanged rather than cleared (an emptied
 * discovery URL would otherwise reset it to the issuer's), and a locked field is never sent.
 */
export const buildSsoUpdateBody = (detail: SsoConnectionDetail, draft: SsoSettingsDraft): UpdateSsoConnectionBody => {
  const initial = initialSsoSettingsDraft(detail)
  const changed = (field: SsoSettingsField) => {
    const value = draft[field].trim()
    return value && value !== initial[field] && !isSsoFieldLocked(detail, field) ? value : undefined
  }
  const compact = <T extends Record<string, string | undefined>>(values: T) => {
    const entries = Object.entries(values).filter(([, value]) => value !== undefined)
    return entries.length > 0 ? (Object.fromEntries(entries) as Partial<T>) : undefined
  }
  const name = changed('name')
  const matchClaim = changed('matchClaim')
  const protocol =
    detail.sso.protocol === 'oidc'
      ? {
          oidc: compact({
            clientId: changed('clientId'),
            discoveryEndpoint: changed('discoveryEndpoint'),
            clientSecret: changed('clientSecret'),
          }),
        }
      : { saml: compact({ entryPoint: changed('entryPoint'), cert: changed('cert') }) }
  return Object.fromEntries(
    Object.entries({ name, matchClaim, ...protocol }).filter(([, value]) => value !== undefined),
  ) as UpdateSsoConnectionBody
}

type UseSsoSettingsStateOptions = {
  detail: SsoConnectionDetail
  onDirty: (dirty: boolean) => void
}

/**
 * The SSO settings form. Locks come from the connection's `lockedFields`; a lock that landed after
 * the read (someone signed in meanwhile) is refused by the server, shown under its field, and the
 * connection is read again so the field shows as locked.
 */
export const useSsoSettingsState = ({ detail, onDirty }: UseSsoSettingsStateOptions) => {
  const queryClient = useQueryClient()
  const [draft, patchDraft] = useReducer(
    (current: SsoSettingsDraft, update: Partial<SsoSettingsDraft>) => ({ ...current, ...update }),
    detail,
    initialSsoSettingsDraft,
  )
  const update = useUpdateSsoConnection(detail.id)
  const body = buildSsoUpdateBody(detail, draft)
  const fieldError = toSsoFieldError(update.error)

  const setField = (field: SsoSettingsField, value: string) => {
    patchDraft({ [field]: value })
    update.reset()
    onDirty(true)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    update.mutate(body, {
      onSuccess: (saved) => {
        patchDraft(initialSsoSettingsDraft(saved as SsoConnectionDetail))
        onDirty(false)
      },
      onError: (error) => {
        if (toSsoFieldError(error)?.isLock) {
          void queryClient.invalidateQueries({ queryKey: adminQueryKeys.connections.detail(detail.id) })
        }
      },
    })
  }

  return {
    draft,
    setField,
    submit,
    isLocked: (field: SsoSettingsField) => isSsoFieldLocked(detail, field),
    hasChanges: Object.keys(body).length > 0,
    isPending: update.isPending,
    isSaved: update.isSuccess,
    fieldError,
    formError: fieldError ? null : update.error,
  }
}
