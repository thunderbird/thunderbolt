/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { APIError } from 'better-auth'
import { DrizzleQueryError } from 'drizzle-orm/errors'
import { type AdmissionErrorCode, AdmissionError } from '../admission-error'

export type AdminErrorResponse = { status: number; body: { code: string; message?: string } & Record<string, unknown> }

const admissionErrorStatus: Record<AdmissionErrorCode, number> = {
  INVALID_DOMAIN: 400,
  DOMAIN_NOT_FOUND: 404,
  INVITATION_NOT_FOUND: 404,
  CONNECTION_NOT_FOUND: 404,
  DOMAIN_NOT_VERIFIED: 409,
  DOMAIN_CLAIMED_BY_IDP: 409,
  ALREADY_MEMBER: 409,
  LINK_REVIEW_INVALID_CURSOR: 400,
  LINK_REVIEW_NOT_FOUND: 404,
  LINK_REVIEW_RESOLVED: 409,
  LINK_REVIEW_SELF: 409,
  LINK_REVIEW_RECORD_EXISTS: 409,
}

/** Unique constraints an admin can hit with ordinary input, and the code each answers with. */
const uniqueViolationCodes: Record<string, string> = {
  identity_connection_org_id_name_uidx: 'CONNECTION_NAME_TAKEN',
  org_domain_org_id_domain_unique: 'DOMAIN_EXISTS',
  local_group_org_id_name_uidx: 'GROUP_NAME_TAKEN',
}

/**
 * Conflicts that come from the admin's input, not from a policy: they change nothing and refuse
 * nothing, so they are not audited as denied attempts.
 */
export const inputConflictCodes = new Set([
  'GROUP_NAME_TAKEN',
  'DOMAIN_EXISTS',
  'CONNECTION_NAME_TAKEN',
  'MAPPING_EXISTS',
  'SSO_PROVIDER_ID_TAKEN',
])

/** The violated unique constraint's name: PGlite reports `constraint`, postgres.js `constraint_name`. */
const violatedConstraint = (error: DrizzleQueryError) => {
  const cause = error.cause as { code?: string; constraint?: string; constraint_name?: string } | undefined
  return cause?.code === '23505' ? (cause.constraint ?? cause.constraint_name) : undefined
}

/**
 * The response for an error an identity service threw: its own status and code for an `APIError`,
 * the documented status for an `AdmissionError`, and a 409 for a known unique violation. Null for
 * anything else, which the generic handler answers.
 */
export const toAdminErrorResponse = (error: unknown): AdminErrorResponse | null => {
  if (error instanceof APIError) {
    const body = (error.body ?? {}) as AdminErrorResponse['body']
    return { status: error.statusCode, body: { ...body, code: body.code ?? error.status } }
  }
  if (error instanceof AdmissionError) {
    return { status: admissionErrorStatus[error.code], body: { code: error.code } }
  }
  if (error instanceof DrizzleQueryError) {
    const code = uniqueViolationCodes[violatedConstraint(error) ?? '']
    return code ? { status: 409, body: { code } } : null
  }
  return null
}
