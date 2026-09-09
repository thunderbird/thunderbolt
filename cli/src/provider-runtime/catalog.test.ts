/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { cliVersion } from '../version.ts'
import { bundledManagedCatalog, fetchManagedCatalog } from './catalog.ts'
import { futureDirectCatalog } from './test-fixtures.ts'
import type { AccountFetch } from './types.ts'

type FetchCall = { readonly url: string; readonly init: RequestInit | undefined }

/** Creates an injected JSON transport while retaining the outbound request. */
const createJsonFetch = (body: string, status = 200) => {
  const calls: FetchCall[] = []
  const fetchFn: AccountFetch = async (input, init) => {
    calls.push({ url: String(input), init })
    return new Response(body, { status, headers: { 'content-type': 'application/json' } })
  }
  return { fetchFn, calls }
}

const firstModel = bundledManagedCatalog.data[0]!

describe('fetchManagedCatalog', () => {
  it('fetches defaults.models over HTTPS in server display order', async () => {
    const reordered = {
      ...bundledManagedCatalog,
      defaultModelId: bundledManagedCatalog.data[1]!.id,
      data: [bundledManagedCatalog.data[1]!, bundledManagedCatalog.data[0]!, ...bundledManagedCatalog.data.slice(2)],
    }
    const { fetchFn, calls } = createJsonFetch(
      JSON.stringify({
        unrelatedConfig: true,
        defaults: { models: reordered },
      }),
    )

    const result = await fetchManagedCatalog('https://api.test', fetchFn)

    expect(result).toEqual(reordered)
    expect(result.data.map(({ id }) => id)).toEqual(reordered.data.map(({ id }) => id))
    expect(calls[0]?.url).toBe('https://api.test/v1/config')
    expect(calls[0]?.init?.method).toBe('GET')
    const headers = new Headers(calls[0]?.init?.headers)
    expect(headers.get('accept')).toBe('application/json')
    expect(headers.get('x-app-version')).toBe(cliVersion)
    expect(calls[0]?.init?.redirect).toBe('error')
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal)
  })

  it.each([
    ['localhost', 'http://localhost:8000/v1', 'http://localhost:8000/v1/config'],
    ['IPv4 loopback', 'http://127.0.0.1:8000/v1/', 'http://127.0.0.1:8000/v1/config'],
    ['IPv6 loopback', 'http://[::1]:8000/v1', 'http://[::1]:8000/v1/config'],
    ['localhost subdomain', 'http://dev.localhost/v1', 'http://dev.localhost/v1/config'],
    ['query and fragment', 'https://api.test/v1?#', 'https://api.test/v1/config'],
  ] as const)('allows plain HTTP for %s', async (_label, backendUrl, expectedUrl) => {
    const { fetchFn, calls } = createJsonFetch(JSON.stringify({ defaults: { models: bundledManagedCatalog } }))

    await expect(fetchManagedCatalog(backendUrl, fetchFn)).resolves.toEqual(bundledManagedCatalog)
    expect(calls[0]?.url).toBe(expectedUrl)
  })

  it.each([
    ['remote HTTP', 'http://api.test/v1'],
    ['non-HTTP scheme', 'ftp://localhost/v1'],
    ['malformed URL', 'not-a-url'],
    ['URL credentials', 'https://user:secret@api.test/v1'],
  ] as const)('rejects %s before issuing a request', async (_label, backendUrl) => {
    const { fetchFn, calls } = createJsonFetch(JSON.stringify({ defaults: { models: bundledManagedCatalog } }))

    await expect(fetchManagedCatalog(backendUrl, fetchFn)).rejects.toMatchObject({ code: 'config-invalid' })
    expect(calls).toHaveLength(0)
  })

  it('accepts a fixture-only future direct model', async () => {
    const { fetchFn } = createJsonFetch(JSON.stringify({ defaults: { models: futureDirectCatalog } }))

    await expect(fetchManagedCatalog('https://api.test/v1', fetchFn)).resolves.toEqual(futureDirectCatalog)
  })

  it.each([
    ['null', null],
    ['blank', ''],
  ] as const)('accepts %s vendor and description values', async (_label, value) => {
    const catalog = { ...bundledManagedCatalog, data: [{ ...firstModel, vendor: value, description: value }] }
    const { fetchFn } = createJsonFetch(JSON.stringify({ defaults: { models: catalog } }))

    await expect(fetchManagedCatalog('https://api.test/v1', fetchFn)).resolves.toEqual(catalog)
  })

  it.each([
    ['zero version', { ...bundledManagedCatalog, version: 0 }],
    ['fractional version', { ...bundledManagedCatalog, version: 1.5 }],
    ['blank default id', { ...bundledManagedCatalog, defaultModelId: ' ' }],
    ['missing data array', { ...bundledManagedCatalog, data: null }],
    ['non-object row', { ...bundledManagedCatalog, data: [null] }],
    ['blank id', { ...bundledManagedCatalog, data: [{ ...firstModel, id: ' ' }] }],
    ['blank model', { ...bundledManagedCatalog, data: [{ ...firstModel, model: ' ' }] }],
    ['blank name', { ...bundledManagedCatalog, data: [{ ...firstModel, name: ' ' }] }],
    ['invalid vendor', { ...bundledManagedCatalog, data: [{ ...firstModel, vendor: 1 }] }],
    ['invalid description', { ...bundledManagedCatalog, data: [{ ...firstModel, description: 1 }] }],
    ['invalid confidentiality', { ...bundledManagedCatalog, data: [{ ...firstModel, isConfidential: 2 }] }],
    ['invalid context window', { ...bundledManagedCatalog, data: [{ ...firstModel, contextWindow: null }] }],
  ] as const)('rejects invalid required field: %s', async (_label, catalog) => {
    const { fetchFn } = createJsonFetch(JSON.stringify({ defaults: { models: catalog } }))

    await expect(fetchManagedCatalog('https://api.test/v1', fetchFn)).rejects.toMatchObject({ code: 'config-invalid' })
  })

  it('rejects a default model id absent from data', async () => {
    const catalog = { ...bundledManagedCatalog, defaultModelId: `${bundledManagedCatalog.defaultModelId}-missing` }
    const { fetchFn } = createJsonFetch(JSON.stringify({ defaults: { models: catalog } }))

    await expect(fetchManagedCatalog('https://api.test/v1', fetchFn)).rejects.toMatchObject({ code: 'config-invalid' })
  })

  it('normalizes Bun fetch failures without exposing the cause', async () => {
    const fetchFn: AccountFetch = async () => {
      throw Object.assign(new Error('socket failed with secret-token'), { code: 'ConnectionRefused' })
    }

    await expect(fetchManagedCatalog('https://api.test/v1', fetchFn)).rejects.toMatchObject({ code: 'network' })
  })

  it('aborts a stalled response and reports a network error', async () => {
    const request = { signal: null as AbortSignal | null }
    const fetchFn: AccountFetch = async (_input, init) => {
      request.signal = init?.signal ?? null
      return await new Promise<Response>((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(request.signal?.reason))
      })
    }

    await expect(fetchManagedCatalog('https://api.test/v1', fetchFn, 1)).rejects.toMatchObject({ code: 'network' })
    expect(request.signal?.aborted).toBeTrue()
  })

  it('normalizes response body read failures', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.error(new Error('stream failed with private detail')),
    })
    const fetchFn: AccountFetch = async () => new Response(body)

    await expect(fetchManagedCatalog('https://api.test/v1', fetchFn)).rejects.toMatchObject({ code: 'network' })
  })

  it('cancels a non-success response body without waiting for cancellation', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true
        return new Promise<void>(() => {})
      },
    })
    const fetchFn: AccountFetch = async () => new Response(body, { status: 503 })

    await expect(fetchManagedCatalog('https://api.test/v1', fetchFn)).rejects.toMatchObject({ code: 'network' })
    expect(cancelled).toBeTrue()
  })

  it.each([
    ['malformed JSON', '{'],
    ['missing defaults', JSON.stringify({ builtInAgentEnabled: true })],
  ] as const)('rejects %s with a config error', async (_label, body) => {
    const fetchFn: AccountFetch = async () => new Response(body)

    await expect(fetchManagedCatalog('https://api.test/v1', fetchFn)).rejects.toMatchObject({ code: 'config-invalid' })
  })
})
