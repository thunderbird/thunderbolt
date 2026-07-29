/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getClock } from '@/testing-library'
import { act } from '@testing-library/react'
import { describe, expect, it, mock } from 'bun:test'
import { withDeadline, withTimeout } from './timeout'

describe('withTimeout', () => {
  it('should resolve with promise value when promise resolves before timeout', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 100, 'test')
    expect(result).toBe('ok')
  })

  it('should resolve with undefined when timeout fires before promise', async () => {
    const neverResolves = new Promise<string>(() => {})

    const resultPromise = withTimeout(neverResolves, 100, 'slow-op')

    await act(async () => {
      await getClock().tickAsync(100)
    })

    const result = await resultPromise
    expect(result).toBeUndefined()
  })

  it('should propagate rejection when promise rejects before timeout', async () => {
    const rejectPromise = Promise.reject(new Error('failed'))

    await expect(withTimeout(rejectPromise, 100, 'reject-op')).rejects.toThrow('failed')
  })

  it('should resolve with undefined when promise rejects after timeout', async () => {
    const slowReject = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('late failure')), 200)
    })

    const resultPromise = withTimeout(slowReject, 50, 'timeout-wins')

    await act(async () => {
      await getClock().runAllAsync()
    })

    const result = await resultPromise
    expect(result).toBeUndefined()
  })
})

describe('withDeadline', () => {
  it('rejects with an error created when the deadline fires', async () => {
    const createError = mock(() => new Error('deadline exceeded'))
    const resultPromise = withDeadline(new Promise<never>(() => {}), 100, createError)
    const errorPromise = resultPromise.then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(createError).not.toHaveBeenCalled()
    await act(async () => {
      await getClock().tickAsync(100)
    })

    await expect(errorPromise).resolves.toMatchObject({ message: 'deadline exceeded' })
    expect(createError).toHaveBeenCalledTimes(1)
  })

  it('does not create the deadline error when the source promise settles first', async () => {
    const createError = mock(() => new Error('deadline exceeded'))

    await expect(withDeadline(Promise.resolve('ok'), 100, createError)).resolves.toBe('ok')
    await act(async () => {
      await getClock().tickAsync(100)
    })

    expect(createError).not.toHaveBeenCalled()
  })
})
