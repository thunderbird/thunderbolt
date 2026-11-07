/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock, spyOn } from 'bun:test'
import { existsSync } from 'node:fs'
import { http } from '../../../../../src/lib/http'
import { allocateStack } from './stack-allocation'
import { backendEnv, frontendEnv } from './env'
import { bootStack } from './boot'

describe('isolated performance stacks', () => {
  it('reserves distinct ports and databases and cleans up only its own allocation', async () => {
    const first = await allocateStack()
    const second = await allocateStack()
    try {
      expect(new Set([first.backendPort, first.frontendPort, second.backendPort, second.frontendPort]).size).toBe(4)
      expect(first.databaseDir).not.toBe(second.databaseDir)
      expect(backendEnv('test', first)).toMatchObject({
        PORT: String(first.backendPort),
        DATABASE_URL: first.databaseDir,
        APP_URL: first.baseUrl,
      })
      expect(frontendEnv(second).VITE_THUNDERBOLT_CLOUD_URL).toBe(`${second.backendUrl}/v1`)
      await first.cleanup()
      expect(existsSync(first.databaseDir)).toBe(false)
      expect(existsSync(second.databaseDir)).toBe(true)
    } finally {
      await first.cleanup()
      await second.cleanup()
    }
  })

  it('never kills another run’s children when one scout finishes', async () => {
    const children: Array<{ kill: ReturnType<typeof mock>; exited: Promise<number> }> = []
    const spawn = spyOn(Bun, 'spawn').mockImplementation(() => {
      const child = { kill: mock(() => {}), exited: Promise.resolve(0) }
      children.push(child)
      return child as unknown as ReturnType<typeof Bun.spawn>
    })
    const readiness = spyOn(http, 'get').mockResolvedValue(new Response('ok'))
    const first = await bootStack('/repository')
    const second = await bootStack('/repository')
    try {
      await first.teardown()
      expect(children).toHaveLength(4)
      expect(spawn.mock.calls[0]?.[0]).toEqual(['bun', '--no-env-file', 'src/index.ts'])
      expect(spawn.mock.calls[1]?.[0]).toEqual([
        'bun',
        '--no-env-file',
        '/repository/.claude/skills/thunder-perf-hunt/scripts/lib/frontend.ts',
      ])
      expect(children[0]?.kill).toHaveBeenCalledTimes(1)
      expect(children[1]?.kill).toHaveBeenCalledTimes(1)
      expect(children[2]?.kill).not.toHaveBeenCalled()
      expect(children[3]?.kill).not.toHaveBeenCalled()
      await second.teardown()
      expect(children[2]?.kill).toHaveBeenCalledTimes(1)
      expect(children[3]?.kill).toHaveBeenCalledTimes(1)
    } finally {
      await first.teardown()
      await second.teardown()
      spawn.mockRestore()
      readiness.mockRestore()
    }
  })
  it('stops an owned backend when frontend startup throws', async () => {
    const backend = { kill: mock(() => {}), exited: Promise.resolve(0) }
    const spawn = spyOn(Bun, 'spawn')
      .mockImplementationOnce(() => backend as unknown as ReturnType<typeof Bun.spawn>)
      .mockImplementationOnce(() => {
        throw new Error('frontend spawn failed')
      })
    const readiness = spyOn(http, 'get').mockResolvedValue(new Response('ok'))
    try {
      await expect(bootStack('/repository')).rejects.toThrow('frontend spawn failed')
      expect(backend.kill).toHaveBeenCalledTimes(1)
    } finally {
      spawn.mockRestore()
      readiness.mockRestore()
    }
  })
})
