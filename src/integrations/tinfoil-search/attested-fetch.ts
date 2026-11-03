/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { t } from '@lingui/core/macro'
import { Identity, PROTOCOL, KeyConfigMismatchError } from 'ehbp'
import { HttpError, type HttpClient } from '@/lib/http'
import type { VerificationDocument } from 'tinfoil'

/** Encrypts against the SDK-verified enclave key, independently of the HTTP transport. */
export const createAttestedSearchFetch = async (
  verification: Pick<VerificationDocument, 'securityVerified' | 'hpkePublicKey'>,
  client: HttpClient,
) => {
  if (!verification.securityVerified || !verification.hpkePublicKey) {
    throw new Error(t`Tinfoil search attestation could not be verified.`)
  }
  const identity = await Identity.fromPublicKeyHex(verification.hpkePublicKey)
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, { ...init, credentials: 'omit', redirect: 'error' })
    const url = new URL(request.url)
    if (url.origin !== 'https://websearch.tinfoil.sh' || url.pathname !== '/mcp' || url.username || url.password) {
      throw new Error(t`Tinfoil search refused an unexpected endpoint.`)
    }
    const method =
      request.method === 'POST'
        ? 'post'
        : request.method === 'GET'
          ? 'get'
          : request.method === 'DELETE'
            ? 'delete'
            : null
    if (!method) {
      throw new Error(t`Tinfoil search refused an unsupported request method.`)
    }
    const { request: encrypted, context } = await identity.encryptRequestWithContext(request, undefined, {
      memoryOnly: true,
    })
    const response = await (async () => {
      try {
        return await client[method](encrypted.url, {
          headers: Object.fromEntries(encrypted.headers),
          body: encrypted.body ? await encrypted.arrayBuffer() : undefined,
          credentials: 'omit',
          signal: request.signal,
          timeout: 30_000,
        })
      } catch (error) {
        if (error instanceof HttpError) {
          return error.response
        }
        throw error
      }
    })()
    if (!context) {
      return response
    }
    if (response.headers.has(PROTOCOL.RESPONSE_NONCE_HEADER)) {
      return identity.decryptResponseWithContext(response, context)
    }
    if (response.status === 422 && response.headers.get('content-type')?.includes('application/problem+json')) {
      const problem: unknown = await response.clone().json()
      if (
        typeof problem === 'object' &&
        problem !== null &&
        'type' in problem &&
        problem.type === PROTOCOL.KEY_CONFIG_PROBLEM_TYPE
      ) {
        throw new KeyConfigMismatchError(t`Tinfoil search encryption keys changed. Try again.`)
      }
    }
    if (!response.ok) {
      return response
    }
    throw new Error(t`Tinfoil search returned an unencrypted response.`)
  }
}
