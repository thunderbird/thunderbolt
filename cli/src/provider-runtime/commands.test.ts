/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { createCommandRouter, mustApplyAfterCancellation } from './commands.ts'
import type { CommandOutcome, ProviderManagerMode, ProviderManagerRunner } from './types.ts'

const managerReturning =
  (expectedMode: ProviderManagerMode, outcome: CommandOutcome, calls: ProviderManagerMode[]): ProviderManagerRunner =>
  async (mode) => {
    calls.push(mode)
    expect(mode).toBe(expectedMode)
    return outcome
  }

const permissionsUnused = async (): Promise<CommandOutcome> => {
  throw new Error('permissions must not open')
}

describe('createCommandRouter', () => {
  test('applies deactivation reconciliation after cancellation but skips other outcomes', () => {
    expect(mustApplyAfterCancellation({ kind: 'deactivate', persist: { type: 'clear-active' } })).toBeTrue()
    expect(mustApplyAfterCancellation({ kind: 'handled' })).toBeFalse()
    expect(mustApplyAfterCancellation({ kind: 'forward', text: 'hello' })).toBeFalse()
    expect(
      mustApplyAfterCancellation({
        kind: 'switch',
        selection: { providerId: 'thunderbolt' },
        persist: { type: 'use', providerId: 'thunderbolt' },
        forceReplace: false,
      }),
    ).toBeFalse()
  })

  test('/providers returns the provider manager outcome', async () => {
    const calls: ProviderManagerMode[] = []
    const outcome: CommandOutcome = { kind: 'handled' }
    const router = createCommandRouter(managerReturning('providers', outcome, calls), permissionsUnused)

    expect(await router.handle('/providers')).toBe(outcome)
    expect(calls).toEqual(['providers'])
  })

  test('/models returns the model manager switch outcome unchanged', async () => {
    const calls: ProviderManagerMode[] = []
    const outcome: CommandOutcome = {
      kind: 'switch',
      selection: { providerId: 'thunderbolt', model: 'opus-5' },
      persist: { type: 'select-model', providerId: 'thunderbolt', model: 'opus-5' },
      forceReplace: false,
    }
    const router = createCommandRouter(managerReturning('models', outcome, calls), permissionsUnused)

    expect(await router.handle('/models')).toEqual({
      kind: 'switch',
      selection: { providerId: 'thunderbolt', model: 'opus-5' },
      persist: { type: 'select-model', providerId: 'thunderbolt', model: 'opus-5' },
      forceReplace: false,
    })
    expect(calls).toEqual(['models'])
  })

  test('/login remains handled when login does not change the active selection', async () => {
    const calls: ProviderManagerMode[] = []
    const router = createCommandRouter(
      managerReturning('login', { kind: 'handled' }, calls),
      permissionsUnused,
    )

    expect(await router.handle('/login')).toEqual({ kind: 'handled' })
    expect(calls).toEqual(['login'])
  })

  test('/login returns a changed active selection unchanged', async () => {
    const calls: ProviderManagerMode[] = []
    const outcome: CommandOutcome = {
      kind: 'switch',
      selection: { providerId: 'thunderbolt' },
      persist: { type: 'use', providerId: 'thunderbolt' },
      forceReplace: true,
    }
    const router = createCommandRouter(managerReturning('login', outcome, calls), permissionsUnused)

    expect(await router.handle('/login')).toBe(outcome)
    expect(calls).toEqual(['login'])
  })

  test('/logout returns deactivation after the manager completes remote logout', async () => {
    const calls: ProviderManagerMode[] = []
    const outcome: CommandOutcome = { kind: 'deactivate', persist: { type: 'clear-active' } }
    const router = createCommandRouter(managerReturning('logout', outcome, calls), permissionsUnused)

    expect(await router.handle('/logout')).toEqual({ kind: 'deactivate', persist: { type: 'clear-active' } })
    expect(calls).toEqual(['logout'])
  })

  test('bare exit and quit return exit outcomes', async () => {
    const manager: ProviderManagerRunner = async () => {
      throw new Error('exit must not open the manager')
    }
    const router = createCommandRouter(manager, permissionsUnused)

    expect(await router.handle('exit')).toEqual({ kind: 'exit' })
    expect(await router.handle('quit')).toEqual({ kind: 'exit' })
  })

  test('unknown slash input is forwarded byte-for-byte', async () => {
    const manager: ProviderManagerRunner = async () => {
      throw new Error('unknown input must not open the manager')
    }
    const router = createCommandRouter(manager, permissionsUnused)

    expect(await router.handle('/other text')).toEqual({ kind: 'forward', text: '/other text' })
    expect(await router.handle('/exit')).toEqual({ kind: 'forward', text: '/exit' })
  })

  test('ordinary text is forwarded byte-for-byte', async () => {
    const manager: ProviderManagerRunner = async () => {
      throw new Error('ordinary text must not open the manager')
    }
    const router = createCommandRouter(manager, permissionsUnused)

    expect(await router.handle('  keep spacing  ')).toEqual({ kind: 'forward', text: '  keep spacing  ' })
  })

  test('/permissions returns the permission selector outcome without opening the provider manager', async () => {
    let calls = 0
    const manager: ProviderManagerRunner = async () => {
      throw new Error('permissions must not open the provider manager')
    }
    const router = createCommandRouter(manager, async () => {
      calls += 1
      return { kind: 'handled' }
    })

    expect(await router.handle('/permissions')).toEqual({ kind: 'handled' })
    expect(calls).toBe(1)
  })
})
