/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import type { CommandSyntaxServeConfig } from '../agent/types.ts'
import { providerRuntimeError } from '../provider-runtime/types.ts'
import type { PreparedPiBinding, ProviderRuntime, ProviderRuntimeError } from '../provider-runtime/types.ts'
import { runAcpServe } from './serve.ts'
import { preparedBinding } from './test-fixtures.ts'

const selection = { providerId: 'selected-profile', model: 'selected-model' }
const config = {
  cwd: process.cwd(),
  yolo: false,
  thinking: 'medium',
  selection,
} satisfies CommandSyntaxServeConfig

/** Builds a typed provider preparation failure for startup propagation tests. */
const runtimeError = (code: ProviderRuntimeError['code'], message: string): Error & ProviderRuntimeError =>
  providerRuntimeError(code, message)

type RuntimeProbe = {
  readonly runtime: ProviderRuntime
  readonly prepared: Parameters<ProviderRuntime['prepare']>[0][]
  readonly calls: { snapshot: number; manage: number }
}

/** Creates a provider runtime that records every operation ACP startup attempts. */
const runtimeProbe = (prepare: ProviderRuntime['prepare']): RuntimeProbe => {
  const prepared: Parameters<ProviderRuntime['prepare']>[0][] = []
  const calls = { snapshot: 0, manage: 0 }
  return {
    prepared,
    calls,
    runtime: {
      snapshot: () => {
        calls.snapshot += 1
        throw new Error('ACP startup must not inspect a manager snapshot')
      },
      manage: async () => {
        calls.manage += 1
        throw new Error('ACP startup must not open login or provider management')
      },
      prepare: async (requested) => {
        prepared.push(requested)
        return prepare(requested)
      },
    },
  }
}

describe('runAcpServe startup probe', () => {
  for (const [name, failure] of [
    ['missing profile', runtimeError('provider-not-found', 'No active provider is configured.')],
    ['ambiguous profile', runtimeError('provider-not-found', 'Provider shorthand is ambiguous.')],
    ['missing model', runtimeError('model-not-found', 'Selected model was not found.')],
    ['authentication required', runtimeError('authentication-required', 'Login or repair is required.')],
    ['invalid config', runtimeError('config-invalid', 'Provider configuration is invalid.')],
  ] as const) {
    test(`${name} fails from prepare before stdio and never opens management`, async () => {
      const probe = runtimeProbe(async () => {
        throw failure
      })

      await expect(runAcpServe(config, probe.runtime)).rejects.toBe(failure)

      expect(probe.prepared).toEqual([selection])
      expect(probe.calls).toEqual({ snapshot: 0, manage: 0 })
    })
  }

  test('disposes the successful probe binding before serving the stdio connection', async () => {
    const events: string[] = []
    let disposals = 0
    const binding = preparedBinding('selected', async () => {
      events.push('dispose')
      disposals += 1
    })
    const probe = runtimeProbe(async () => binding)
    await runAcpServe(config, probe.runtime, {
      serveConnection: async () => {
        events.push('serve')
      },
    })

    expect(probe.prepared).toEqual([selection])
    expect(disposals).toBe(1)
    expect(events).toEqual(['dispose', 'serve'])
    expect(probe.calls).toEqual({ snapshot: 0, manage: 0 })
  })

  test('bounds a startup probe whose provider runtime ignores cancellation before opening stdio', async () => {
    const started = Promise.withResolvers<void>()
    const probe = runtimeProbe(async () => {
      started.resolve()
      return new Promise<PreparedPiBinding>(() => {})
    })
    let served = 0
    const pending = runAcpServe(config, probe.runtime, {
      serveConnection: async () => {
        served += 1
      },
      signal: AbortSignal.timeout(5),
    })
    await started.promise

    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(served).toBe(0)
  })

  test('rechecks cancellation after probe disposal before opening the stdio connection', async () => {
    const controller = new AbortController()
    const probe = runtimeProbe(async () => preparedBinding('selected', async () => controller.abort()))
    let served = 0
    const serving = runAcpServe(config, probe.runtime, {
      serveConnection: async () => {
        served += 1
      },
      signal: controller.signal,
    })

    await expect(serving).rejects.toMatchObject({ name: 'AbortError' })
    expect(served).toBe(0)
  })

  test('closes the post-probe microtask gap before opening the stdio connection', async () => {
    const controller = new AbortController()
    const probe = runtimeProbe(async () =>
      preparedBinding('selected', async () => {
        queueMicrotask(() => queueMicrotask(() => controller.abort()))
      }),
    )
    let served = 0
    const serving = runAcpServe(config, probe.runtime, {
      serveConnection: async () => {
        served += 1
      },
      signal: controller.signal,
    })

    await expect(serving).rejects.toMatchObject({ name: 'AbortError' })
    expect(served).toBe(0)
  })
})
