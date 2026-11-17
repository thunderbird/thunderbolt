/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { MessageDescriptor } from '@lingui/core'
import type { AdminErrorCode } from '@shared/admin-api'
import { AdminApiError } from '../../api/client'
import { getAdminErrorMessage } from '../../api/error-messages'

/** Every field of the SSO create and edit forms. */
export const ssoFormFields = [
  'name',
  'providerId',
  'issuer',
  'clientId',
  'clientSecret',
  'discoveryEndpoint',
  'entityId',
  'entryPoint',
  'cert',
  'idpIssuer',
  'matchClaim',
] as const

export type SsoFormField = (typeof ssoFormFields)[number]

export type SsoFieldError = {
  field: SsoFormField
  message: MessageDescriptor
  /** The field locked since the form was read: the caller refetches the connection to show it. */
  isLock: boolean
}

const isSsoFormField = (value: unknown): value is SsoFormField => ssoFormFields.includes(value as SsoFormField)

/** Codes that always concern one field. */
const fixedFields: Partial<Record<AdminErrorCode, SsoFormField>> = {
  SSO_MATCH_CLAIM_LOCKED: 'matchClaim',
  SSO_DISCOVERY_URL_INVALID: 'discoveryEndpoint',
  SSO_DISCOVERY_URL_UNTRUSTED: 'discoveryEndpoint',
  SSO_PROVIDER_ID_INVALID: 'providerId',
  SSO_PROVIDER_ID_TAKEN: 'providerId',
  CONNECTION_NAME_TAKEN: 'name',
}

/** Codes whose body names the field. */
const namedFieldCodes = new Set<string>(['SSO_IDENTITY_FIELD_LOCKED', 'SSO_IDENTITY_FIELD_IMMUTABLE'])

const lockCodes = new Set<string>(['SSO_IDENTITY_FIELD_LOCKED', 'SSO_MATCH_CLAIM_LOCKED'])

/** The form field a refused SSO save belongs under, or null when the error belongs above the form. */
export const toSsoFieldError = (error: unknown): SsoFieldError | null => {
  if (!(error instanceof AdminApiError)) {
    return null
  }
  const field = namedFieldCodes.has(error.code) ? error.field : fixedFields[error.code as AdminErrorCode]
  if (!isSsoFormField(field)) {
    return null
  }
  return { field, message: getAdminErrorMessage(error), isLock: lockCodes.has(error.code) }
}
