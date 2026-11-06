/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'

import {
  approveDeviceCode,
  denyDeviceCode,
  normalizeUserCode,
  verifyDeviceCode,
  type DeviceGrantClient,
} from './device-grant'

type FetchResult = { data: unknown; error: unknown }

type ConsoleErrorSpy = ReturnType<typeof spyOn>

const consoleError = { current: undefined as ConsoleErrorSpy | undefined }

beforeEach(() => {
  consoleError.current = spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => consoleError.current?.mockRestore())

/**
 * Build a fake device-grant client (DI, no module mocking). `respond` receives the path
 * so a single fake can answer verify/approve/deny differently.
 */
const fakeClient = (respond: (path: string, options?: unknown) => FetchResult | Promise<FetchResult>) => {
  const fetch = mock(async (path: string, options?: unknown) => respond(path, options))
  return { client: { $fetch: fetch } as unknown as DeviceGrantClient, fetch }
}

describe('verifyDeviceCode', () => {
  it('claims the code via GET /device with the user_code query and returns status', async () => {
    const { client, fetch } = fakeClient(() => ({ data: { user_code: 'ABCD1234', status: 'pending' }, error: null }))

    const result = await verifyDeviceCode(client, 'ABCD1234')

    expect(result).toEqual({ ok: true, status: 'pending' })
    expect(fetch).toHaveBeenCalledWith('/device', { method: 'GET', query: { user_code: 'ABCD1234' } })
  })

  it('surfaces the terminal status when the code was already approved', async () => {
    const { client } = fakeClient(() => ({ data: { user_code: 'ABCD1234', status: 'approved' }, error: null }))

    const result = await verifyDeviceCode(client, 'ABCD1234')

    expect(result).toEqual({ ok: true, status: 'approved' })
  })

  it('classifies an expired_token error as expired', async () => {
    const { client } = fakeClient(() => ({
      data: null,
      error: { error: 'expired_token', error_description: 'User code has expired', status: 400 },
    }))

    const result = await verifyDeviceCode(client, 'ABCD1234')

    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ reason: 'expired' })
  })

  it('classifies an invalid_request error as invalid', async () => {
    const { client } = fakeClient(() => ({
      data: null,
      error: { error: 'invalid_request', error_description: 'Invalid user code', status: 400 },
    }))

    const result = await verifyDeviceCode(client, 'NOPE')

    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ reason: 'invalid' })
  })

  it('reports a backend failure as unavailable without blaming the code', async () => {
    const error = { error: 'internal_server_error', status: 503 }
    const { client } = fakeClient(() => ({ data: null, error }))

    const result = await verifyDeviceCode(client, 'ABCD1234')

    expect(result).toEqual({
      ok: false,
      reason: 'unavailable',
      message: 'The sign-in service is unavailable right now. Check your connection and try again.',
    })
    expect(consoleError.current).toHaveBeenCalledWith('Device grant request failed', error)
  })

  it('reports a transport failure as unavailable and logs the underlying error', async () => {
    const underlyingError = new TypeError('Failed to fetch')
    const error = { error: underlyingError, status: 500, statusText: 'Fetch Error' }
    const { client } = fakeClient(() => ({ data: null, error }))

    const result = await verifyDeviceCode(client, 'ABCD1234')

    expect(result).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(consoleError.current).toHaveBeenCalledWith('Device grant request failed', underlyingError)
  })

  it('treats a missing body as an invalid code', async () => {
    const { client } = fakeClient(() => ({ data: null, error: null }))

    const result = await verifyDeviceCode(client, 'ABCD1234')

    expect(result).toMatchObject({ ok: false, reason: 'invalid' })
  })
})

describe('approveDeviceCode', () => {
  it('POSTs the userCode to /device/approve and succeeds', async () => {
    const { client, fetch } = fakeClient(() => ({ data: { success: true }, error: null }))

    const result = await approveDeviceCode(client, 'ABCD1234')

    expect(result).toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledWith('/device/approve', { method: 'POST', body: { userCode: 'ABCD1234' } })
  })

  it('reports expiry when the code expired before approval', async () => {
    const { client } = fakeClient(() => ({
      data: null,
      error: { error: 'expired_token', error_description: 'User code has expired', status: 400 },
    }))

    const result = await approveDeviceCode(client, 'ABCD1234')

    expect(result).toMatchObject({ ok: false, reason: 'expired' })
  })

  it('reports invalid when the request was already processed', async () => {
    const { client } = fakeClient(() => ({
      data: null,
      error: { error: 'invalid_request', error_description: 'Device code already processed', status: 400 },
    }))

    const result = await approveDeviceCode(client, 'ABCD1234')

    expect(result).toMatchObject({ ok: false, reason: 'invalid' })
  })
})

describe('denyDeviceCode', () => {
  it('POSTs the userCode to /device/deny and succeeds', async () => {
    const { client, fetch } = fakeClient(() => ({ data: { success: true }, error: null }))

    const result = await denyDeviceCode(client, 'ABCD1234')

    expect(result).toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledWith('/device/deny', { method: 'POST', body: { userCode: 'ABCD1234' } })
  })
})

describe('normalizeUserCode', () => {
  it('trims and uppercases', () => {
    expect(normalizeUserCode('  abcd-1234 ')).toBe('ABCD-1234')
  })

  it('returns an empty string for blank input', () => {
    expect(normalizeUserCode('   ')).toBe('')
  })
})
