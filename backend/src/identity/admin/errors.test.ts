/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { APIError } from 'better-auth'
import { describe, expect, it } from 'bun:test'
import { DrizzleQueryError } from 'drizzle-orm/errors'
import { AdmissionError } from '../admission-error'
import { toAdminErrorResponse } from './errors'

const uniqueViolation = (constraint: Record<string, string>) =>
  new DrizzleQueryError('insert …', [], Object.assign(new Error('duplicate key'), { code: '23505', ...constraint }))

describe('toAdminErrorResponse', () => {
  it('keeps an APIError’s status, code and extra fields', () => {
    const error = new APIError('CONFLICT', { message: 'Managed', code: 'FIELD_MANAGED_BY_IDP', field: 'name' })
    expect(toAdminErrorResponse(error)).toEqual({
      status: 409,
      body: { message: 'Managed', code: 'FIELD_MANAGED_BY_IDP', field: 'name' },
    })
    expect(
      toAdminErrorResponse(new APIError('NOT_FOUND', { message: 'x', code: 'SCIM_CONNECTION_NOT_FOUND' }))?.status,
    ).toBe(404)
  })

  it.each([
    ['INVALID_DOMAIN', 400],
    ['DOMAIN_NOT_FOUND', 404],
    ['INVITATION_NOT_FOUND', 404],
    ['CONNECTION_NOT_FOUND', 404],
    ['DOMAIN_NOT_VERIFIED', 409],
    ['DOMAIN_CLAIMED_BY_IDP', 409],
    ['ALREADY_MEMBER', 409],
    ['LINK_REVIEW_INVALID_CURSOR', 400],
    ['LINK_REVIEW_NOT_FOUND', 404],
    ['LINK_REVIEW_RESOLVED', 409],
    ['LINK_REVIEW_SELF', 409],
    ['LINK_REVIEW_RECORD_EXISTS', 409],
  ] as const)('maps AdmissionError %s to %i', (code, status) => {
    expect(toAdminErrorResponse(new AdmissionError(code))).toEqual({ status, body: { code } })
  })

  it('maps known unique violations from either driver, and leaves the rest to the generic handler', () => {
    expect(toAdminErrorResponse(uniqueViolation({ constraint: 'local_group_org_id_name_uidx' }))).toEqual({
      status: 409,
      body: { code: 'GROUP_NAME_TAKEN' },
    })
    expect(toAdminErrorResponse(uniqueViolation({ constraint_name: 'identity_connection_org_id_name_uidx' }))).toEqual({
      status: 409,
      body: { code: 'CONNECTION_NAME_TAKEN' },
    })
    expect(toAdminErrorResponse(uniqueViolation({ constraint: 'some_other_unique' }))).toBeNull()
    expect(toAdminErrorResponse(new Error('boom'))).toBeNull()
  })
})
