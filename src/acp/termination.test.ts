/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { TransportTerminationError } from './termination'

describe('TransportTerminationError', () => {
  it('carries a stable reason and preserves its cause', () => {
    const cause = new Error('relay dropped')
    const error = new TransportTerminationError('stream-error', 'ACP stream failed', { cause })

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('TransportTerminationError')
    expect(error.reason).toBe('stream-error')
    expect(error.cause).toBe(cause)
  })
})
