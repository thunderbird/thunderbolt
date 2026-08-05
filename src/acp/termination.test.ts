/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { getTransportTermination, TransportTerminationError } from './termination'

describe('TransportTerminationError', () => {
  it('carries a stable reason and preserves its cause', () => {
    const cause = new Error('relay dropped')
    const error = new TransportTerminationError('stream-error', 'ACP stream failed', { cause })

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('TransportTerminationError')
    expect(error.reason).toBe('stream-error')
    expect(error.cause).toBe(cause)
  })

  it('defaults to retryable and carries an explicit non-retryable verdict', () => {
    expect(new TransportTerminationError('remote-close', 'dropped').retryable).toBe(true)
    expect(new TransportTerminationError('remote-close', 'revoked', { retryable: false }).retryable).toBe(false)
  })
})

describe('getTransportTermination', () => {
  it('finds the termination through a wrapper cause chain', () => {
    const cause = new TransportTerminationError('remote-close', 'closed', { retryable: false })
    const wrapped = new Error('connection lost', { cause: new Error('middle', { cause }) })

    expect(getTransportTermination(wrapped)).toBe(cause)
    expect(getTransportTermination(cause)).toBe(cause)
  })

  it('returns undefined for errors without a transport termination cause', () => {
    expect(getTransportTermination(new Error('plain'))).toBeUndefined()
    expect(getTransportTermination('nope')).toBeUndefined()
    expect(getTransportTermination(undefined)).toBeUndefined()
  })
})
