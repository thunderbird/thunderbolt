/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AgentHarness } from '@earendil-works/pi-agent-core'
import { describe, expect, spyOn, test } from 'bun:test'
import type { SharedModel } from '../../../shared/defaults/models.ts'
import { cliVersion } from '../version.ts'
import { createManagedDirectBinding } from './direct.ts'
import {
  failedCompletion,
  futureDirectModel,
  runBinding,
  successfulCompletion,
  testSessionCredential,
} from './test-fixtures.ts'
import type { AccountFetch, ResolvedAccountCredential } from './types.ts'

const sessionCredential = (backendUrl = 'https://api.test/v1'): ResolvedAccountCredential =>
  testSessionCredential({ backendUrl, bearer: 'stored-session-bearer' })

const patCredential = (backendUrl = 'https://api.test/v1'): ResolvedAccountCredential => ({
  type: 'pat',
  backendUrl,
  token: 'environment-pat',
})

const requestUrl = (input: Parameters<AccountFetch>[0]): string => String(input)

describe('createManagedDirectBinding — generic managed model', () => {
  test('binds the stable catalog id while sending an unknown future direct slug through Pi', async () => {
    const requests: { readonly url: string; readonly headers: Headers; readonly body: unknown }[] = []
    const catalogWithForbiddenOrigin = {
      ...futureDirectModel,
      baseUrl: 'https://catalog-controlled.example/v1',
    } satisfies SharedModel & { readonly baseUrl: string }
    const binding = await createManagedDirectBinding({
      credential: sessionCredential(),
      model: catalogWithForbiddenOrigin,
      observeResponse: async () => {},
      fetchFn: async (input, init) => {
        requests.push({
          url: requestUrl(input),
          headers: new Headers(init?.headers),
          body: (await new Response(init?.body).json()) as unknown,
        })
        return successfulCompletion(futureDirectModel.model)
      },
    })

    const message = await runBinding(binding)

    expect(binding).toMatchObject({
      providerId: 'thunderbolt',
      wireModel: 'future-direct-fixture',
      persistsCredentialStatus: false,
    })
    expect(binding.piModel).toMatchObject({
      id: 'future-direct-fixture',
      provider: 'thunderbolt',
      reasoning: true,
      contextWindow: futureDirectModel.contextWindow,
      input: ['text', 'image'],
    })
    expect(message.stopReason).toBe('stop')
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      url: 'https://api.test/v1/chat/completions',
      body: { model: 'future-direct-fixture' },
    })
  })

  test.each([['anthropic', ['text', 'image']], [null, ['text']]] as const)('maps image support from catalog vendor %s', async (vendor, input) => {
    const imageModel: SharedModel = {
      ...futureDirectModel,
      vendor,
    }
    const binding = await createManagedDirectBinding({
      credential: patCredential(),
      model: imageModel,
      observeResponse: async () => {},
      fetchFn: async () => successfulCompletion(imageModel.model),
    })

    expect(binding.piModel.input).toEqual([...input])
  })

  test('rejects a confidential model at the direct producer seam', async () => {
    const confidential: SharedModel = { ...futureDirectModel, isConfidential: 1 }

    await expect(
      createManagedDirectBinding({
        credential: patCredential(),
        model: confidential,
        observeResponse: async () => {},
      }),
    ).rejects.toMatchObject({ code: 'config-invalid' })
  })
})

describe('createManagedDirectBinding — credential isolation', () => {
  test('preserves a managed response when its status observer fails', async () => {
    const errorLog = spyOn(console, 'error').mockImplementation(() => {})
    let requests = 0
    try {
      const binding = await createManagedDirectBinding({
        credential: patCredential(),
        model: futureDirectModel,
        observeResponse: async () => {
          throw new Error('disk full')
        },
        fetchFn: async () => {
          requests += 1
          return successfulCompletion(futureDirectModel.model)
        },
      })

      const message = await runBinding(binding)

      expect(message.stopReason).toBe('stop')
      expect(requests).toBe(1)
      expect(errorLog).toHaveBeenCalledTimes(1)
    } finally {
      errorLog.mockRestore()
    }
  })

  test.each([
    ['session', sessionCredential(), 'authorization', 'Bearer stored-session-bearer'] as const,
    ['PAT', patCredential(), 'x-api-key', 'environment-pat'] as const,
  ])(
    'blocks cross-origin redirects before the %s credential can reach the target',
    async (_kind, credential, headerName, headerValue) => {
      const targetHeaders: Headers[] = []
      const target = Bun.serve({
        port: 0,
        fetch: (request) => {
          targetHeaders.push(request.headers)
          return successfulCompletion(futureDirectModel.model)
        },
      })
      const sourceHeaders: Headers[] = []
      const source = Bun.serve({
        port: 0,
        fetch: (request) => {
          sourceHeaders.push(request.headers)
          return Response.redirect(`http://127.0.0.1:${target.port}/stolen`, 302)
        },
      })

      try {
        const binding = await createManagedDirectBinding({
          credential: { ...credential, backendUrl: `http://127.0.0.1:${source.port}` },
          model: futureDirectModel,
          observeResponse: async () => {},
        })

        const message = await runBinding(binding)

        expect(message.stopReason).toBe('error')
        expect(sourceHeaders).toHaveLength(1)
        expect(sourceHeaders[0]?.get(headerName)).toBe(headerValue)
        expect(targetHeaders).toEqual([])
      } finally {
        source.stop(true)
        target.stop(true)
      }
    },
  )

  test('session requests emit only the stored Bearer credential', async () => {
    const requestHeaders: Headers[] = []
    const binding = await createManagedDirectBinding({
      credential: sessionCredential(),
      model: futureDirectModel,
      observeResponse: async () => {},
      fetchFn: async (_input, init) => {
        requestHeaders.push(new Headers(init?.headers))
        return successfulCompletion(futureDirectModel.model)
      },
    })

    await runBinding(binding)

    expect(requestHeaders).toHaveLength(1)
    expect(requestHeaders[0]?.get('authorization')).toBe('Bearer stored-session-bearer')
    expect(requestHeaders[0]?.get('x-app-version')).toBe(cliVersion)
    expect(requestHeaders[0]?.has('x-api-key')).toBe(false)
  })

  test('PAT requests remove the SDK Bearer header and emit only x-api-key', async () => {
    const requestHeaders: Headers[] = []
    const binding = await createManagedDirectBinding({
      credential: patCredential(),
      model: futureDirectModel,
      observeResponse: async () => {},
      fetchFn: async (_input, init) => {
        requestHeaders.push(new Headers(init?.headers))
        return successfulCompletion(futureDirectModel.model)
      },
    })

    await runBinding(binding)

    expect(binding.persistsCredentialStatus).toBeFalse()
    expect(requestHeaders).toHaveLength(1)
    expect(requestHeaders[0]?.has('authorization')).toBe(false)
    expect(requestHeaders[0]?.get('x-api-key')).toBe('environment-pat')
  })

  test('reports authenticated response evidence for session and PAT without owning persistence policy', async () => {
    const observedResponses: string[] = []
    const session = await createManagedDirectBinding({
      credential: sessionCredential(),
      model: futureDirectModel,
      observeResponse: async (response) => {
        observedResponses.push(`session:${response.status}`)
      },
      fetchFn: async () => failedCompletion(401),
    })
    const pat = await createManagedDirectBinding({
      credential: patCredential(),
      model: futureDirectModel,
      observeResponse: async (response) => {
        observedResponses.push(`pat:${response.status}`)
      },
      fetchFn: async () => failedCompletion(401),
    })

    const sessionError = await runBinding(session)
    const patError = await runBinding(pat)
    expect(sessionError.stopReason).toBe('error')
    expect(patError.stopReason).toBe('error')
    expect(observedResponses).toEqual(['session:401', 'pat:401'])
  })
})

describe('createManagedDirectBinding — secure backend origin', () => {
  test.each([
    ['remote plain HTTP', 'http://api.example.test/v1'],
    ['a malformed URL', 'not a URL'],
  ] as const)('rejects %s as invalid configuration before any request is constructed', async (_case, backendUrl) => {
    let requests = 0

    await expect(
      createManagedDirectBinding({
        credential: sessionCredential(backendUrl),
        model: futureDirectModel,
        observeResponse: async () => {},
        fetchFn: async () => {
          requests += 1
          return successfulCompletion(futureDirectModel.model)
        },
      }),
    ).rejects.toMatchObject({
      code: 'config-invalid',
    })
    expect(requests).toBe(0)
  })

  test('allows loopback HTTP and normalizes it to the backend inference endpoint', async () => {
    const urls: string[] = []
    const binding = await createManagedDirectBinding({
      credential: patCredential('http://127.0.0.1:8000'),
      model: futureDirectModel,
      observeResponse: async () => {},
      fetchFn: async (input) => {
        urls.push(requestUrl(input))
        return successfulCompletion(futureDirectModel.model)
      },
    })

    await runBinding(binding)

    expect(urls).toEqual(['http://127.0.0.1:8000/v1/chat/completions'])
  })
})

describe('createManagedDirectBinding — no fallback or replay', () => {
  test.each([
    ['authentication', 401],
    ['quota', 429],
    ['direct backend', 503],
  ] as const)('%s failure makes exactly one inference request', async (_kind, status) => {
    const urls: string[] = []
    const binding = await createManagedDirectBinding({
      credential: patCredential(),
      model: futureDirectModel,
      observeResponse: async () => {},
      fetchFn: async (input) => {
        urls.push(requestUrl(input))
        return failedCompletion(status)
      },
    })

    const message = await runBinding(binding)

    expect(message.stopReason).toBe('error')
    expect(urls).toEqual(['https://api.test/v1/chat/completions'])
  })

  test('network failure makes exactly one inference request', async () => {
    let requests = 0
    const binding = await createManagedDirectBinding({
      credential: patCredential(),
      model: futureDirectModel,
      observeResponse: async () => {},
      fetchFn: async () => {
        requests += 1
        throw new Error('offline')
      },
    })

    const message = await runBinding(binding)

    expect(message.stopReason).toBe('error')
    expect(requests).toBe(1)
  })

  test('exposes no-op attach and dispose lifecycle hooks because usage is backend-accounted', async () => {
    const binding = await createManagedDirectBinding({
      credential: patCredential(),
      model: futureDirectModel,
      observeResponse: async () => {},
    })

    const detach = binding.attach({} as AgentHarness)
    expect(detach()).toBeUndefined()
    await expect(binding.dispose()).resolves.toBeUndefined()
  })
})
