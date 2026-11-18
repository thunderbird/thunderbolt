/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { describe, expect, it } from 'bun:test'
import { parseScimFailure } from './scim-failure-details'

describe('parseScimFailure', () => {
  it('reads the request a failed SCIM event records', () => {
    expect(
      parseScimFailure({
        method: 'POST',
        resourceType: 'Users',
        resourceId: null,
        status: 400,
        scimType: 'invalidValue',
        detail: 'externalId is required',
      }),
    ).toEqual({
      method: 'POST',
      resourceType: 'Users',
      resourceId: null,
      status: 400,
      scimType: 'invalidValue',
      detail: 'externalId is required',
    })
  })

  it('tolerates missing and mistyped fields', () => {
    expect(parseScimFailure({ method: 'PATCH', status: '409', detail: 42 })).toEqual({
      method: 'PATCH',
      resourceType: null,
      resourceId: null,
      status: null,
      scimType: null,
      detail: null,
    })
  })

  it('gives up on metadata that is not a SCIM request', () => {
    expect(parseScimFailure(null)).toBeNull()
    expect(parseScimFailure('POST')).toBeNull()
    expect(parseScimFailure({ status: 400 })).toBeNull()
  })
})
