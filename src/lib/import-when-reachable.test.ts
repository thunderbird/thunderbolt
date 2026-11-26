/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, mock } from 'bun:test'
import { stubAppServer } from '@/test-utils/app-server'
import { getClock } from '@/testing-library'
import { importWhenReachable } from './import-when-reachable'

describe('importWhenReachable', () => {
  afterEach(() => mock.restore())

  it.each(['down', 'error'] as const)(
    'never imports while the server is %s, and imports once it is up',
    async (answer) => {
      const load = mock(async () => 'module')
      const loadWhenReachable = importWhenReachable(load)
      const server = stubAppServer(answer)
      await expect(loadWhenReachable()).rejects.toThrow()
      expect(load).not.toHaveBeenCalled()

      stubAppServer('up')
      expect(await loadWhenReachable()).toBe('module')
      expect(await loadWhenReachable()).toBe('module')
      // One check while it was not up and one once it was: after the import loaded, it does not ask again.
      expect(server).toHaveBeenCalledTimes(2)
      expect(load).toHaveBeenCalledTimes(1)
    },
  )

  it('gives up on a server that never answers after five seconds, and checks again on the next call', async () => {
    const load = mock(async () => 'module')
    const loadWhenReachable = importWhenReachable(load)
    const server = stubAppServer('silent')
    const settled = mock((outcome: string) => outcome)
    void loadWhenReachable().then(
      () => settled('loaded'),
      (error: DOMException) => settled(error.name),
    )

    await getClock().tickAsync(4999)
    expect(settled).not.toHaveBeenCalled()
    await getClock().tickAsync(1)
    expect(settled).toHaveBeenCalledWith('TimeoutError')
    expect(load).not.toHaveBeenCalled()

    stubAppServer('up')
    expect(await loadWhenReachable()).toBe('module')
    expect(server).toHaveBeenCalledTimes(2)
  })

  it('checks and imports again after the import failed', async () => {
    const load = mock(async () => 'module')
    load.mockImplementationOnce(async () => {
      throw new Error('Importing a module script failed.')
    })
    const loadWhenReachable = importWhenReachable(load)
    const server = stubAppServer('up')
    await expect(loadWhenReachable()).rejects.toThrow('Importing a module script failed.')

    expect(await loadWhenReachable()).toBe('module')
    expect(server).toHaveBeenCalledTimes(2)
  })
})
