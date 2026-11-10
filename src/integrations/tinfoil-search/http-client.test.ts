/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { EnclaveHTTPClient } from 'tinfoil'
import { testTinfoilVerification, testTinfoilVerifier } from '@/test-utils/tinfoil'
import {
  Identity,
  PROTOCOL,
  bytesToHex,
  hexToBytes,
  HPKE_REQUEST_INFO,
  EXPORT_LABEL,
  EXPORT_LENGTH,
  RESPONSE_NONCE_LENGTH,
  deriveResponseKeys,
  encryptChunk,
} from 'ehbp'
import { CipherSuite, KEM_DHKEM_X25519_HKDF_SHA256, KDF_HKDF_SHA256, AEAD_AES_256_GCM, type Key } from 'hpke'
import { createClient, type HttpClient } from '@/lib/http'
import * as nativeTransport from '@/lib/native-fetch'
import {
  createBrowserSearchClient,
  createSearchNetworkFetch,
  nativeSearchClient,
  SearchAcknowledgment,
} from './http-client'
import { createTinfoilToolCaller } from './transport'

afterEach(() => mock.restore())

/** Stub only attestation evidence; requests use the released SDK's real encrypted transport. */
const prepareClient = async (httpClient: HttpClient) => {
  const suite = new CipherSuite(KEM_DHKEM_X25519_HKDF_SHA256, KDF_HKDF_SHA256, AEAD_AES_256_GCM)
  const { publicKey, privateKey } = await suite.GenerateKeyPair(true)
  const identity = await Identity.fromPublicKeyHex(
    bytesToHex(new Uint8Array(await suite.SerializePublicKey(publicKey))),
  )
  const hpkePublicKey = await identity.getPublicKeyHex()
  const verify = mock(async () => testTinfoilVerification(hpkePublicKey))
  const attestation = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async () =>
        Response.json({
          domain: 'websearch.tinfoil.sh',
          enclaveAttestationReport: { format: 'test', body: '' },
        }),
      { preconnect: globalThis.fetch.preconnect },
    ),
  )
  const secure = await EnclaveHTTPClient.create('websearch.tinfoil.sh', 'tinfoilsh/confidential-websearch', {
    transportMode: 'ehbp',
    userCacheSecret: 'test-secret',
    verifier: testTinfoilVerifier(verify),
    fetch: createSearchNetworkFetch(httpClient),
  })
  return { secure, privateKey, verify, attestation }
}

/** Emulate an enclave: open the request and encrypt its streamed response with the same HPKE context. */
const respond = async (privateKey: Key, request: Request, result: (plaintext: string) => string) => {
  const suite = new CipherSuite(KEM_DHKEM_X25519_HKDF_SHA256, KDF_HKDF_SHA256, AEAD_AES_256_GCM)
  const enc = hexToBytes(request.headers.get(PROTOCOL.ENCAPSULATED_KEY_HEADER)!)
  const recipient = await suite.SetupRecipient(privateKey, enc, {
    info: new TextEncoder().encode(HPKE_REQUEST_INFO),
  })
  const body = new Uint8Array(await request.arrayBuffer())
  const length = new DataView(body.buffer, body.byteOffset, 4).getUint32(0, false)
  const plaintext = new TextDecoder().decode(await recipient.Open(body.slice(4, 4 + length)))
  const nonce = crypto.getRandomValues(new Uint8Array(RESPONSE_NONCE_LENGTH))
  const secret = await recipient.Export(new TextEncoder().encode(EXPORT_LABEL), EXPORT_LENGTH)
  const keys = await deriveResponseKeys(secret, enc, nonce)
  const encrypted = await encryptChunk(keys, 0, new TextEncoder().encode(result(plaintext)))
  const frame = new Uint8Array(4 + encrypted.length)
  new DataView(frame.buffer).setUint32(0, encrypted.length, false)
  frame.set(encrypted, 4)
  return new Response(frame, {
    headers: { [PROTOCOL.RESPONSE_NONCE_HEADER]: bytesToHex(nonce), 'content-type': 'text/event-stream' },
  })
}

it('encrypts through the browser relay and decrypts streamed results', async () => {
  const send = mock(async (input: RequestInfo | URL) => {
    const request = input as Request
    expect(request.url).toBe('https://app.example/_tinfoil/search')
    expect(request.credentials).toBe('omit')
    expect(request.redirect).toBe('error')
    expect(request.headers.get('authorization')).toBe('Bearer test-provider-token')
    expect(await request.clone().text()).not.toContain('private query')
    return respond(privateKey, request, (plaintext) => {
      expect(JSON.parse(plaintext)).toEqual({ query: 'private query' })
      return 'event: message\ndata: {"results":[]}\n\n'
    })
  })
  const { secure, privateKey, attestation } = await prepareClient(
    createBrowserSearchClient('https://app.example', send),
  )
  const response = await secure.fetch('https://websearch.tinfoil.sh/mcp', {
    method: 'POST',
    headers: { authorization: 'Bearer test-provider-token' },
    body: '{"query":"private query"}',
  })
  expect(await response.text()).toBe('event: message\ndata: {"results":[]}\n\n')
  expect(send).toHaveBeenCalledTimes(1)
  expect(attestation).toHaveBeenCalledTimes(1)
  await expect(secure.fetch('https://other.example/mcp', { method: 'POST', body: '{}' })).rejects.toThrow(
    'bound to enclave',
  )
  expect(send).toHaveBeenCalledTimes(1)
})

it('lets the SDK reject plaintext success and preserve authentication failures', async () => {
  const send = mock(async () => Response.json({ results: ['untrusted'] }))
  const { secure } = await prepareClient(createClient({ fetch: send }))
  await expect(secure.fetch('https://websearch.tinfoil.sh/mcp', { method: 'POST', body: '{}' })).rejects.toMatchObject({
    name: 'NetworkError',
  })
  send.mockImplementation(async () => new Response('Unauthorized', { status: 401 }))
  expect((await secure.fetch('https://websearch.tinfoil.sh/mcp', { method: 'POST', body: '{}' })).status).toBe(401)
})

it('retains the injected transport when the SDK re-verifies after key rotation', async () => {
  const send = mock(async () =>
    Response.json(
      { type: PROTOCOL.KEY_CONFIG_PROBLEM_TYPE },
      {
        status: 422,
        headers: { 'content-type': 'application/problem+json' },
      },
    ),
  )
  const { secure, verify } = await prepareClient(createClient({ fetch: send }))
  await expect(secure.fetch('https://websearch.tinfoil.sh/mcp', { method: 'POST', body: '{}' })).rejects.toMatchObject({
    name: 'AttestationError',
  })
  expect(verify).toHaveBeenCalledTimes(2)
  expect(send).toHaveBeenCalledTimes(2)
})

it.each([undefined, ''])('blocks bodyless POSTs before networking: %s', async (body) => {
  const send = mock(async () => new Response())
  const { secure } = await prepareClient(createClient({ fetch: send }))
  await expect(secure.fetch('https://websearch.tinfoil.sh/mcp', { method: 'POST', body })).rejects.toThrow(
    'unencrypted request',
  )
  expect(send).not.toHaveBeenCalled()
})

it.each([
  { url: 'https://other.example/mcp', method: 'POST' },
  { url: 'https://websearch.tinfoil.sh/other', method: 'POST' },
  { url: 'https://websearch.tinfoil.sh/mcp', method: 'PUT' },
])('rejects unexpected network destinations and methods: $url $method', async ({ url, method }) => {
  const send = mock(async () => new Response())
  const networkFetch = createSearchNetworkFetch(createClient({ fetch: send }))
  await expect(
    networkFetch(url, { method, headers: { 'ehbp-encapsulated-key': 'test' }, body: 'ciphertext' }),
  ).rejects.toThrow(/unexpected endpoint|unsupported request method/)
  expect(send).not.toHaveBeenCalled()
})

it('supports MCP notification acknowledgments without accepting their plaintext bodies', async () => {
  const cancel = mock(() => {})
  const requests: string[] = []
  const send = mock(async (input: RequestInfo | URL) => {
    const request = input as Request
    expect(request.method).toBe('POST')
    const response = await respond(privateKey, request, (plaintext) => {
      const message = JSON.parse(plaintext)
      requests.push(message.method)
      const result =
        message.method === 'initialize'
          ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } }
          : { content: [{ type: 'text', text: '{"results":[]}' }] }
      return `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`
    })
    return requests.at(-1) === 'notifications/initialized'
      ? new Response(new ReadableStream({ cancel }), { status: 202 })
      : response
  })
  const { secure, privateKey } = await prepareClient(createClient({ fetch: send }))
  const caller = createTinfoilToolCaller(async () => 'test', { acquire: async () => secure, evict: () => {} })
  expect(await caller('search', { query: 'private query' })).toMatchObject({ content: [{ text: '{"results":[]}' }] })
  expect(requests).toEqual(['initialize', 'notifications/initialized', 'tools/call'])
  expect(cancel).toHaveBeenCalledTimes(1)
})

it('discards bodyless session termination responses', async () => {
  const cancel = mock(() => {})
  const { secure } = await prepareClient(
    createClient({ fetch: async () => new Response(new ReadableStream({ cancel })) }),
  )
  const error = await secure
    .fetch('https://websearch.tinfoil.sh/mcp', { method: 'DELETE' })
    .catch((error: unknown) => error)
  const acknowledgement = (error as Error).cause as SearchAcknowledgment
  expect(acknowledgement).toBeInstanceOf(SearchAcknowledgment)
  expect(acknowledgement.response.body).toBeNull()
  expect(cancel).toHaveBeenCalledTimes(1)
})

it('preserves cancellation and uses native HTTP without cloud authentication', async () => {
  const send = spyOn(nativeTransport, 'nativeFetch').mockResolvedValue(new Response('Unauthorized', { status: 401 }))
  const { secure } = await prepareClient(nativeSearchClient)
  const controller = new AbortController()
  await secure.fetch('https://websearch.tinfoil.sh/mcp', { method: 'POST', body: '{}', signal: controller.signal })
  expect(send).toHaveBeenCalledTimes(1)
  const request = send.mock.calls[0][0] as Request
  expect(send.mock.calls[0][1]?.redirect).toBe('error')
  expect(request.credentials).toBe('omit')
  expect(request.headers.has(PROTOCOL.ENCAPSULATED_KEY_HEADER)).toBe(true)
  controller.abort()
  expect(request.signal.aborted).toBe(true)
})
