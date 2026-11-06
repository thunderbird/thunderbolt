/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import { killProcessWhenConnectionCloses } from './lifecycle.ts'

describe('killProcessWhenConnectionCloses', () => {
  it('kills the process when the connection closes normally', async () => {
    const kill = mock(() => {})
    killProcessWhenConnectionCloses({ closed: async () => {} }, { kill })

    await Promise.resolve()
    expect(kill).toHaveBeenCalledTimes(1)
  })

  it('kills the process when waiting for connection close rejects', async () => {
    const kill = mock(() => {})
    killProcessWhenConnectionCloses(
      {
        closed: async () => {
          throw new Error('close failed')
        },
      },
      { kill },
    )

    await Promise.resolve()
    await Promise.resolve()
    expect(kill).toHaveBeenCalledTimes(1)
  })
})
