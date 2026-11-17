/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { HttpError } from '@/lib/http'
import { describe, expect, it } from 'bun:test'
import { AdminApiError } from './client'
import { adminErrorMessages, getAdminErrorMessage } from './error-messages'

describe('getAdminErrorMessage', () => {
  it("uses the code's message", () => {
    expect(getAdminErrorMessage(new AdminApiError(409, 'GROUP_NAME_TAKEN', {}))).toBe(
      adminErrorMessages.GROUP_NAME_TAKEN,
    )
  })

  it('falls back for an unknown code or error', () => {
    const generic = getAdminErrorMessage(new Error('boom'))
    expect(getAdminErrorMessage(new AdminApiError(500, 'SOMETHING_NEW', {}))).toBe(generic)
    expect(getAdminErrorMessage(new HttpError(new Response(null, { status: 500 })))).toBe(generic)
  })

  it('says when the server is unreachable', () => {
    const network = getAdminErrorMessage(new TypeError('Failed to fetch'))
    expect(network).not.toBe(getAdminErrorMessage(new Error('boom')))
  })
})
