/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

/** What a failed `scim.request` audit event records about the request (never its body). */
export type ScimFailureDetails = {
  method: string
  resourceType: string | null
  resourceId: string | null
  status: number | null
  scimType: string | null
  detail: string | null
}

/** A non-empty string from metadata, else null. */
const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null)

/**
 * The request a failed `scim.request` event describes, read from its metadata, or null when the
 * metadata isn't in that shape (an older or foreign event).
 */
export const parseScimFailure = (metadata: unknown): ScimFailureDetails | null => {
  if (typeof metadata !== 'object' || metadata === null) {
    return null
  }
  const fields = metadata as Record<string, unknown>
  const method = text(fields.method)
  if (!method) {
    return null
  }
  return {
    method,
    resourceType: text(fields.resourceType),
    resourceId: text(fields.resourceId),
    status: typeof fields.status === 'number' ? fields.status : null,
    scimType: text(fields.scimType),
    detail: text(fields.detail),
  }
}
