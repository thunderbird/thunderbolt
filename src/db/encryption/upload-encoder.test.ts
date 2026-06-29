/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, beforeEach, mock } from 'bun:test'
import { generateCK } from '@/crypto'
import { useConfigStore } from '@/api/config-store'

let mockCK: CryptoKey | null = null

mock.module('@/crypto/key-storage', () => ({
  getCK: async () => mockCK,
  storeCK: async () => {},
  storeKeyPair: async () => {},
  getKeyPair: async () => null,
  clearCK: async () => {},
  clearAllKeys: async () => {},
}))

// Re-provide config module to override leaked mocks from other test files
// (bun's mock.module leaks across files and can replace encryptedColumnsMap with {})
const realConfig = await import('./config')
mock.module('@/db/encryption/config', () => ({
  ...realConfig,
  isEncryptionEnabled: () => useConfigStore.getState().config.e2eeEnabled === true,
}))

const { invalidateCKCache } = await import('./codec')
const { encodeForUpload } = await import('./upload-encoder')

const personalWsId = 'personal-ws-1'
const sharedWsId = 'shared-ws-2'

describe('encodeForUpload', () => {
  beforeEach(async () => {
    invalidateCKCache()
    mockCK = await generateCK()
    useConfigStore.getState().updateConfig({ e2eeEnabled: true })
  })

  afterEach(() => {
    useConfigStore.setState({ config: {} })
  })

  it('encrypts encrypted columns for known tables (personal-workspace row)', async () => {
    const op = {
      op: 'PUT' as const,
      type: 'tasks',
      id: '123',
      data: { item: 'Buy groceries', order: 1, is_complete: 0, workspace_id: personalWsId },
    }

    const result = await encodeForUpload(op, personalWsId)

    expect(typeof result.data?.item).toBe('string')
    expect((result.data?.item as string).startsWith('__enc:')).toBe(true)
    expect(result.data?.order).toBe(1)
    expect(result.data?.is_complete).toBe(0)
  })

  it('passes through DELETE operations', async () => {
    const op = { op: 'DELETE' as const, type: 'tasks', id: '123' }
    const result = await encodeForUpload(op, personalWsId)
    expect(result).toEqual(op)
  })

  it('passes through unknown tables', async () => {
    const op = {
      op: 'PUT' as const,
      type: 'unknown_table',
      id: '123',
      data: { foo: 'bar' },
    }

    const result = await encodeForUpload(op, personalWsId)
    expect(result.data?.foo).toBe('bar')
  })

  it('does not encrypt non-string values', async () => {
    const op = {
      op: 'PUT' as const,
      type: 'tasks',
      id: '123',
      data: { item: null, order: 5, workspace_id: personalWsId },
    }

    const result = await encodeForUpload(op, personalWsId)
    expect(result.data?.item).toBeNull()
    expect(result.data?.order).toBe(5)
  })

  it('encrypts encrypted columns for PATCH operations', async () => {
    const op = {
      op: 'PATCH' as const,
      type: 'tasks',
      id: '123',
      data: { item: 'Updated task', workspace_id: personalWsId },
    }

    const result = await encodeForUpload(op, personalWsId)
    expect((result.data?.item as string).startsWith('__enc:')).toBe(true)
  })

  it('encrypts multiple columns', async () => {
    const op = {
      op: 'PUT' as const,
      type: 'chat_messages',
      id: '456',
      data: {
        content: 'Hello',
        parts: '[{"type":"text"}]',
        chat_thread_id: 'thread-1',
        workspace_id: personalWsId,
      },
    }

    const result = await encodeForUpload(op, personalWsId)

    expect((result.data?.content as string).startsWith('__enc:')).toBe(true)
    expect((result.data?.parts as string).startsWith('__enc:')).toBe(true)
    expect(result.data?.chat_thread_id).toBe('thread-1')
  })

  it('encrypts personal workspaces.name', async () => {
    const op = {
      op: 'PUT' as const,
      type: 'workspaces',
      id: personalWsId,
      data: {
        name: 'Personal',
        is_personal: 1,
        owner_user_id: 'user-1',
      },
    }

    const result = await encodeForUpload(op, personalWsId)

    expect((result.data?.name as string).startsWith('__enc:')).toBe(true)
    expect(result.data?.is_personal).toBe(1)
    expect(result.data?.owner_user_id).toBe('user-1')
  })

  // --- Per-workspace scope (temporary; see upload-encoder.ts @todo) ---

  it('skips encryption for workspace-scoped resources in a shared workspace', async () => {
    const op = {
      op: 'PUT' as const,
      type: 'models',
      id: 'm-1',
      data: { name: 'GPT-4', model: 'gpt-4', workspace_id: sharedWsId },
    }

    const result = await encodeForUpload(op, personalWsId)

    expect(result.data?.name).toBe('GPT-4')
    expect(result.data?.model).toBe('gpt-4')
  })

  it('encrypts workspace-scoped resources in the personal workspace', async () => {
    const op = {
      op: 'PUT' as const,
      type: 'models',
      id: 'm-1',
      data: { name: 'GPT-4', model: 'gpt-4', workspace_id: personalWsId },
    }

    const result = await encodeForUpload(op, personalWsId)

    expect((result.data?.name as string).startsWith('__enc:')).toBe(true)
    expect((result.data?.model as string).startsWith('__enc:')).toBe(true)
  })

  it('leaves a shared workspaces.name as plaintext', async () => {
    const op = {
      op: 'PUT' as const,
      type: 'workspaces',
      id: sharedWsId,
      data: { name: 'Engineering', is_personal: 0, owner_user_id: null },
    }

    const result = await encodeForUpload(op, personalWsId)

    expect(result.data?.name).toBe('Engineering')
  })

  it('always encrypts chat_threads regardless of workspace scope (per-user table)', async () => {
    const op = {
      op: 'PUT' as const,
      type: 'chat_threads',
      id: 'ct-1',
      data: { title: 'My thread', workspace_id: sharedWsId },
    }

    const result = await encodeForUpload(op, personalWsId)

    expect((result.data?.title as string).startsWith('__enc:')).toBe(true)
  })

  it('always encrypts chat_messages regardless of workspace scope (per-user table)', async () => {
    const op = {
      op: 'PUT' as const,
      type: 'chat_messages',
      id: 'cm-1',
      data: { content: 'Hi', parts: '[]', workspace_id: sharedWsId },
    }

    const result = await encodeForUpload(op, personalWsId)

    expect((result.data?.content as string).startsWith('__enc:')).toBe(true)
    expect((result.data?.parts as string).startsWith('__enc:')).toBe(true)
  })

  it('always encrypts tasks regardless of workspace scope (per-user table)', async () => {
    const op = {
      op: 'PUT' as const,
      type: 'tasks',
      id: 't-1',
      data: { item: 'Ship it', workspace_id: sharedWsId },
    }

    const result = await encodeForUpload(op, personalWsId)

    expect((result.data?.item as string).startsWith('__enc:')).toBe(true)
  })

  it('encrypts per-account tables (settings, devices) regardless of personalWorkspaceId', async () => {
    const settingsOp = {
      op: 'PUT' as const,
      type: 'settings',
      id: 's-1',
      data: { value: 'on' },
    }
    const devicesOp = {
      op: 'PUT' as const,
      type: 'devices',
      id: 'd-1',
      data: { name: "Alice's laptop" },
    }

    const settingsResult = await encodeForUpload(settingsOp, null)
    const devicesResult = await encodeForUpload(devicesOp, null)

    expect((settingsResult.data?.value as string).startsWith('__enc:')).toBe(true)
    expect((devicesResult.data?.name as string).startsWith('__enc:')).toBe(true)
  })

  it('passes workspace-scoped rows through plaintext when personalWorkspaceId is unresolved', async () => {
    const op = {
      op: 'PUT' as const,
      type: 'models',
      id: 'm-1',
      data: { name: 'GPT-4', model: 'gpt-4', workspace_id: personalWsId },
    }

    const result = await encodeForUpload(op, null)

    expect(result.data?.name).toBe('GPT-4')
    expect(result.data?.model).toBe('gpt-4')
  })
})
