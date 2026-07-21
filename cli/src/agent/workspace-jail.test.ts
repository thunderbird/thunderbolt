/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createWorkspaceTools,
  resolveExistingPathInWorkspace,
  resolveWritablePathInWorkspace,
} from './workspace-jail.ts'

describe('workspace jail', () => {
  let parentDir: string
  let workspaceDir: string
  let outsideDir: string

  beforeEach(async () => {
    parentDir = await mkdtemp(join(tmpdir(), 'thunderbolt-jail-'))
    workspaceDir = join(parentDir, 'workspace')
    outsideDir = join(parentDir, 'outside')
    await mkdir(workspaceDir)
    await mkdir(outsideDir)
    await writeFile(join(workspaceDir, 'inside.txt'), 'inside')
    await writeFile(join(outsideDir, 'secret.txt'), 'secret')
  })

  afterEach(async () => {
    await rm(parentDir, { recursive: true, force: true })
  })

  test('accepts existing paths inside workspace, including workspace root', async () => {
    const realWorkspace = await realpath(workspaceDir)
    expect(await resolveExistingPathInWorkspace(workspaceDir, '.')).toBe(realWorkspace)
    expect(await resolveExistingPathInWorkspace(workspaceDir, 'inside.txt')).toBe(join(realWorkspace, 'inside.txt'))
  })

  test('rejects lexical escapes and sibling-prefix collisions', async () => {
    await expect(resolveExistingPathInWorkspace(workspaceDir, '../outside/secret.txt')).rejects.toThrow(
      'path escapes workspace',
    )
    await expect(resolveExistingPathInWorkspace(workspaceDir, `${workspaceDir}-other`)).rejects.toThrow(
      'path escapes workspace',
    )
  })

  test('rejects existing paths reached through a symlink outside workspace', async () => {
    await symlink(outsideDir, join(workspaceDir, 'linked-outside'))

    await expect(resolveExistingPathInWorkspace(workspaceDir, 'linked-outside/secret.txt')).rejects.toThrow(
      'path escapes workspace',
    )
  })

  test('accepts a missing write target only when its real existing ancestor is inside workspace', async () => {
    const realWorkspace = await realpath(workspaceDir)
    expect(await resolveWritablePathInWorkspace(workspaceDir, 'new/nested/file.txt')).toBe(
      join(realWorkspace, 'new/nested/file.txt'),
    )

    await symlink(outsideDir, join(workspaceDir, 'linked-outside'))
    await expect(resolveWritablePathInWorkspace(workspaceDir, 'linked-outside/new.txt')).rejects.toThrow(
      'path escapes workspace',
    )
  })

  test('read, write, and edit tools enforce jail before filesystem access', async () => {
    await symlink(outsideDir, join(workspaceDir, 'linked-outside'))
    const tools = createWorkspaceTools(workspaceDir)
    const read = tools.find((tool) => tool.name === 'read')
    const write = tools.find((tool) => tool.name === 'write')
    const edit = tools.find((tool) => tool.name === 'edit')
    if (!read || !write || !edit) throw new Error('workspace tools missing')

    await expect(read.execute('read-outside', { path: 'linked-outside/secret.txt' })).rejects.toThrow(
      'path escapes workspace',
    )
    await expect(write.execute('write-outside', { path: 'linked-outside/new.txt', content: 'nope' })).rejects.toThrow(
      'path escapes workspace',
    )
    await expect(
      edit.execute('edit-outside', {
        path: 'linked-outside/secret.txt',
        edits: [{ oldText: 'secret', newText: 'stolen' }],
      }),
    ).rejects.toThrow('path escapes workspace')
  })

  test('exposes only path-confined filesystem tools', () => {
    expect(createWorkspaceTools(workspaceDir).map((tool) => tool.name)).toEqual(['read', 'write', 'edit'])
  })
})
