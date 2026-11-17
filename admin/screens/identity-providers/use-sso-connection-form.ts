/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { FormEvent } from 'react'
import { useReducer } from 'react'
import type { AdminConnection, AdminConnectionDetail, CreateSsoConnectionBody, SsoProtocol } from '@shared/admin-api'
import { presetMatchClaim, type ProviderPreset } from './provider-presets'
import { toSsoFieldError } from './sso-field-errors'
import { useCreateSsoConnection } from './use-connection-queries'

export type SsoCreateDraft = {
  name: string
  providerId: string
  preset: ProviderPreset
  matchClaim: string
  /** Once the admin types a match claim, picking a provider no longer replaces it. */
  matchClaimTouched: boolean
  issuer: string
  clientId: string
  clientSecret: string
  discoveryEndpoint: string
  entityId: string
  entryPoint: string
  cert: string
  idpIssuer: string
}

export type SsoCreateTextField = Exclude<keyof SsoCreateDraft, 'preset' | 'matchClaimTouched'>

type SsoCreateAction =
  | { type: 'set'; field: SsoCreateTextField; value: string }
  | { type: 'preset'; preset: ProviderPreset; protocol: SsoProtocol }

export const initialSsoCreateDraft = (protocol: SsoProtocol): SsoCreateDraft => ({
  name: '',
  providerId: '',
  preset: 'other',
  matchClaim: presetMatchClaim('other', protocol),
  matchClaimTouched: false,
  issuer: '',
  clientId: '',
  clientSecret: '',
  discoveryEndpoint: '',
  entityId: '',
  entryPoint: '',
  cert: '',
  idpIssuer: '',
})

export const ssoCreateReducer = (draft: SsoCreateDraft, action: SsoCreateAction): SsoCreateDraft => {
  if (action.type === 'preset') {
    return {
      ...draft,
      preset: action.preset,
      matchClaim: draft.matchClaimTouched ? draft.matchClaim : presetMatchClaim(action.preset, action.protocol),
    }
  }
  return {
    ...draft,
    [action.field]: action.value,
    matchClaimTouched: draft.matchClaimTouched || action.field === 'matchClaim',
  }
}

/** A connection taking an SSO side: the backend still requires its name, which stays as it is. */
export type SsoAttachTarget = Pick<AdminConnection, 'id' | 'name'>

/**
 * The create body. Attaching to an existing connection sends its id and current name; a blank
 * discovery URL or match claim is left to the server (the issuer's discovery URL, `sub`).
 */
export const buildCreateSsoBody = (
  protocol: SsoProtocol,
  draft: SsoCreateDraft,
  attachTo?: SsoAttachTarget,
): CreateSsoConnectionBody => {
  const value = (field: SsoCreateTextField) => draft[field].trim()
  const discoveryEndpoint = value('discoveryEndpoint')
  const matchClaim = value('matchClaim')
  return {
    name: attachTo?.name ?? value('name'),
    providerId: value('providerId'),
    protocol:
      protocol === 'oidc'
        ? {
            oidc: {
              issuer: value('issuer'),
              clientId: value('clientId'),
              clientSecret: value('clientSecret'),
              ...(discoveryEndpoint && { discoveryEndpoint }),
            },
          }
        : {
            saml: {
              entityId: value('entityId'),
              entryPoint: value('entryPoint'),
              cert: value('cert'),
              idpIssuer: value('idpIssuer'),
            },
          },
    ...(matchClaim && { matchClaim }),
    ...(attachTo && { identityConnectionId: attachTo.id }),
  }
}

type UseSsoConnectionFormOptions = {
  protocol: SsoProtocol
  attachTo?: SsoAttachTarget
  onCreated: (connection: AdminConnectionDetail) => void
  onDirty: (dirty: boolean) => void
}

/** The SSO create form: its draft, the provider preset, and where a refusal shows. */
export const useSsoConnectionForm = ({ protocol, attachTo, onCreated, onDirty }: UseSsoConnectionFormOptions) => {
  const [draft, dispatch] = useReducer(ssoCreateReducer, protocol, initialSsoCreateDraft)
  const create = useCreateSsoConnection()
  const fieldError = toSsoFieldError(create.error)

  const setField = (field: SsoCreateTextField, value: string) => {
    dispatch({ type: 'set', field, value })
    onDirty(true)
  }

  const setPreset = (preset: ProviderPreset) => {
    dispatch({ type: 'preset', preset, protocol })
    onDirty(true)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    create.mutate(buildCreateSsoBody(protocol, draft, attachTo), {
      onSuccess: (connection) => {
        onDirty(false)
        onCreated(connection)
      },
    })
  }

  return {
    draft,
    setField,
    setPreset,
    submit,
    isPending: create.isPending,
    fieldError,
    formError: fieldError ? null : create.error,
  }
}
