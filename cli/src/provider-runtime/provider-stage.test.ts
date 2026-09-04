/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import type { Api, Model } from '@earendil-works/pi-ai'
import {
  createProviderStageContext,
  prepareProviderBinding,
} from './provider-stage.ts'
import type { ByokProfile, PreparedPiBinding, ProviderRuntime } from './types.ts'

const profile = (apiKey: string): ByokProfile => ({
  id: 'byok-work',
  label: 'Work',
  provider: 'openai',
  defaultModel: 'gpt-test',
  apiKey,
  credentialStatus: 'authenticated',
})

describe('ProviderStageContext', () => {
  test('keeps a staged credential internal and clears only the acquired generation', () => {
    const stage = createProviderStageContext()
    stage.stage(profile('first-secret'))
    const first = stage.get('byok-work')
    expect(first?.profile).toEqual(profile('first-secret'))

    expect(stage.clear(first!)).toBe(true)
    stage.stage(profile('second-secret'))

    expect(stage.clear(first!)).toBe(false)
    expect(stage.get('byok-work')?.profile.apiKey).toBe('second-secret')
  })

  test('rejects overlapping candidates for the same profile instead of guessing which one to commit', () => {
    const stage = createProviderStageContext()
    stage.stage(profile('first-secret'))

    expect(() => stage.stage(profile('second-secret'))).toThrow(/already staged/i)
    expect(stage.get('byok-work')?.profile.apiKey).toBe('first-secret')
  })
})

describe('prepareProviderBinding', () => {
  test.each(['caller cancellation', 'deadline'] as const)(
    'settles ignored preparation on %s and disposes a binding that resolves late',
    async (cause) => {
      const controller = new AbortController()
      const started = Promise.withResolvers<void>()
      const result = Promise.withResolvers<PreparedPiBinding>()
      const disposed = Promise.withResolvers<void>()
      let receivedSignal: AbortSignal | undefined
      let disposals = 0
      const binding: PreparedPiBinding = {
        providerId: 'byok-work',
        wireModel: 'model',
        persistsCredentialStatus: true,
        piModel: { provider: 'byok-work', id: 'model' } as Model<Api>,
        install: () => {},
        attach: () => () => {},
        observePromptError: async () => {},
        dispose: async () => {
          disposals += 1
          disposed.resolve()
        },
      }
      const runtime: ProviderRuntime = {
        snapshot: () => {
          throw new Error('unexpected snapshot')
        },
        manage: async () => {
          throw new Error('unexpected manage')
        },
        prepare: async (_selection, signal) => {
          receivedSignal = signal
          started.resolve()
          return result.promise
        },
      }
      const pending = prepareProviderBinding(
        runtime,
        { providerId: 'byok-work' },
        {
          signal: cause === 'caller cancellation' ? controller.signal : undefined,
          timeoutMs: cause === 'deadline' ? 5 : 5_000,
        },
      )
      await started.promise
      if (cause === 'caller cancellation') controller.abort()

      await expect(pending).rejects.toMatchObject({
        name: cause === 'caller cancellation' ? 'AbortError' : 'TimeoutError',
      })
      expect(receivedSignal?.aborted).toBeTrue()
      result.resolve(binding)
      await disposed.promise
      expect(disposals).toBe(1)
    },
  )
})
