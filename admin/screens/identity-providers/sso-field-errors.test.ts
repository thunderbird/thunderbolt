/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { describe, expect, it } from 'bun:test'
import { AdminApiError } from '../../api/client'
import { adminErrorMessages } from '../../api/error-messages'
import { toSsoFieldError } from './sso-field-errors'

const refusal = (code: string, field?: string) => new AdminApiError(409, code, { code, field })

describe('toSsoFieldError', () => {
  it('puts a lock refusal under the field the body names', () => {
    expect(toSsoFieldError(refusal('SSO_IDENTITY_FIELD_LOCKED', 'clientId'))).toEqual({
      field: 'clientId',
      message: adminErrorMessages.SSO_IDENTITY_FIELD_LOCKED,
      isLock: true,
    })
  })

  it('puts a match-claim lock under the match claim', () => {
    expect(toSsoFieldError(refusal('SSO_MATCH_CLAIM_LOCKED'))).toMatchObject({ field: 'matchClaim', isLock: true })
  })

  it('places an immutable field without treating it as a lock', () => {
    expect(toSsoFieldError(refusal('SSO_IDENTITY_FIELD_IMMUTABLE', 'issuer'))).toMatchObject({
      field: 'issuer',
      isLock: false,
    })
  })

  it('places discovery URL and provider ID refusals', () => {
    expect(toSsoFieldError(refusal('SSO_DISCOVERY_URL_UNTRUSTED'))?.field).toBe('discoveryEndpoint')
    expect(toSsoFieldError(refusal('SSO_PROVIDER_ID_TAKEN'))?.field).toBe('providerId')
  })

  it('leaves other errors, and unknown fields, above the form', () => {
    expect(toSsoFieldError(refusal('SSO_CONNECTION_ENV_OWNED'))).toBeNull()
    expect(toSsoFieldError(refusal('SSO_IDENTITY_FIELD_LOCKED', 'somethingNew'))).toBeNull()
    expect(toSsoFieldError(new Error('offline'))).toBeNull()
  })
})
