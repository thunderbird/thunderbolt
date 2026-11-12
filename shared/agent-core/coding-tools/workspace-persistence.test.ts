/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import * as fsp from '@zenfs/core/promises'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { BrowserExecutionEnv } from '../browser-env/browser-execution-env.ts'
import { mountInMemoryFs } from '../browser-env/mount.ts'
import { createBrowserCodingTools } from './index.ts'

const workspaceDir = '/workspace/tool-persistence'
let persistenceCount = 0
let bash: AgentTool
let read: AgentTool
let write: AgentTool
let edit: AgentTool

beforeAll(async () => {
  await mountInMemoryFs()
})

beforeEach(async () => {
  await fsp.rm(workspaceDir, { recursive: true, force: true })
  await fsp.mkdir(workspaceDir, { recursive: true })
  persistenceCount = 0
  const env = new BrowserExecutionEnv({
    cwd: workspaceDir,
    persistWorkspace: async () => {
      persistenceCount += 1
    },
  })
  ;[bash, read, write, edit] = createBrowserCodingTools(env, { cwd: workspaceDir })
})

const run = (tool: AgentTool, args: unknown) =>
  (tool.execute as (id: string, input: unknown, signal?: AbortSignal) => Promise<unknown>)('test-call', args)

describe('coding tool workspace persistence', () => {
  it('does not persist read-only commands or reads', async () => {
    await run(bash, { command: 'printf ready' })
    expect(persistenceCount).toBe(0)
    await fsp.writeFile(`${workspaceDir}/source.txt`, 'source')
    await run(read, { path: 'source.txt' })
    expect(persistenceCount).toBe(0)
  })

  it('persists write and edit changes before returning tool results', async () => {
    await run(write, { path: 'source.txt', content: 'before' })
    expect(persistenceCount).toBe(1)
    await run(edit, { path: 'source.txt', edits: [{ oldText: 'before', newText: 'after' }] })
    expect(persistenceCount).toBe(2)
  })

  it('persists shell mutations even when the command exits unsuccessfully', async () => {
    await expect(run(bash, { command: 'printf saved > durable.txt; false' })).rejects.toThrow(/exited with code/)
    expect(persistenceCount).toBe(1)
    expect(await fsp.readFile(`${workspaceDir}/durable.txt`, 'utf-8')).toBe('saved')
  })
})
