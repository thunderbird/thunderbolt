/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { removeAccountPasskey } from './use-remove-passkey'

const recordingSteps = (holdsSlot: boolean, e2eeReady = true) => {
  const calls: string[] = []
  return {
    calls,
    steps: {
      holdsSyncSlot: async () => holdsSlot,
      removeSyncSlot: async () => {
        calls.push('remove-slot')
      },
      deletePasskey: async () => {
        calls.push('delete-passkey')
      },
      e2eeReady,
    },
  }
}

describe('removeAccountPasskey', () => {
  it('drops the sync slot before deleting the passkey', async () => {
    const { calls, steps } = recordingSteps(true)
    expect(await removeAccountPasskey(steps)).toBe('removed')
    expect(calls).toEqual(['remove-slot', 'delete-passkey'])
  })

  it('deletes a passkey that holds no slot without rotating', async () => {
    const { calls, steps } = recordingSteps(false)
    expect(await removeAccountPasskey(steps)).toBe('removed')
    expect(calls).toEqual(['delete-passkey'])
  })

  it('touches nothing when the slot needs a rotation this device cannot run', async () => {
    const { calls, steps } = recordingSteps(true, false)
    expect(await removeAccountPasskey(steps)).toBe('needs-sync')
    expect(calls).toEqual([])
  })

  it('does not delete the passkey when the slot rotation fails', async () => {
    const { calls, steps } = recordingSteps(true)
    const failing = {
      ...steps,
      removeSyncSlot: async () => {
        throw new Error('rotation failed')
      },
    }
    await expect(removeAccountPasskey(failing)).rejects.toThrow('rotation failed')
    expect(calls).toEqual([])
  })
})
