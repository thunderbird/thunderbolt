/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { createMcpServer, getAllMcpServers, getMcpServerCredentials } from '@/dal'
import { getDb } from '@/db/database'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import { useAddServerForm } from '@/hooks/use-add-server-form'
import type { FetchFn } from '@/lib/proxy-fetch'
import type { ConnectionsPageAction } from './page-state'
import { resolveCredentialUpdate, useMcpServerFormController } from './use-mcp-server-form-controller'

describe('resolveCredentialUpdate', () => {
  it('replaces the stored credential when a token was typed', () => {
    expect(resolveCredentialUpdate('new-token', false, 'bearer')).toEqual({ type: 'bearer', token: 'new-token' })
    // A typed token wins even when the clear toggle was flipped first.
    expect(resolveCredentialUpdate('new-token', true, 'bearer')).toEqual({ type: 'bearer', token: 'new-token' })
  })

  it('deletes only an explicitly cleared stored bearer', () => {
    expect(resolveCredentialUpdate('', true, 'bearer')).toBeNull()
  })

  it('does not delete when clearing but no bearer is stored', () => {
    expect(resolveCredentialUpdate('', true, 'none')).toBeUndefined()
    expect(resolveCredentialUpdate('', true, 'oauth')).toBeUndefined()
  })

  it('keeps the stored credential when the field is untouched', () => {
    expect(resolveCredentialUpdate('', false, 'bearer')).toBeUndefined()
    expect(resolveCredentialUpdate('', false, 'none')).toBeUndefined()
  })
})

describe('MCP form submission ownership', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  beforeEach(resetTestDatabase)
  afterEach(cleanup)

  const renderController = async (overrides: Partial<Parameters<typeof useMcpServerFormController>[0]> = {}) => {
    const servers = await getAllMcpServers(getDb())
    const dispatch = mock((_action: ConnectionsPageAction) => {})
    const wrapper = createTestProvider()
    const hook = renderHook(
      () => {
        const form = useAddServerForm({
          cloudUrl: 'https://cloud.example',
          onClearDialogError: () => {},
          deps: {
            probeMcpServerTools: async () => [],
            classifyMcpServerAuth: async () => 'authorizable',
            buildOAuthFetch: () =>
              Object.assign(async () => new Response(), { preconnect: async () => true }) as FetchFn,
          },
        })
        const controller = useMcpServerFormController({
          db: getDb(),
          form,
          servers,
          credentialsById: {},
          jsonText: '{"mcpServers":{"example":{"url":"https://example.com/mcp"}}}',
          dispatch,
          clearDialogError: () => {},
          startAddAndAuthorize: async () => true,
          updateLiveServer: async () => {},
          enrollIroh: async () => {},
          ...overrides,
        })
        return { form, controller }
      },
      { wrapper },
    )
    act(() => hook.result.current.form.changeUrl('https://example.com/mcp'))
    return { ...hook, dispatch, servers }
  }

  it('persists the submitted transport and credential if the form changes before the mutation runs', async () => {
    const { result } = await renderController()
    act(() => result.current.form.changeToken('submitted-token'))
    const saving = result.current.controller.add()
    act(() => {
      result.current.controller.cancel()
      result.current.form.changeTransport('sse')
      result.current.form.changeToken('replacement-token')
    })
    await act(async () => {
      await saving
    })
    const [saved] = await getAllMcpServers(getDb())
    expect(saved.type).toBe('http')
    expect(await getMcpServerCredentials(getDb(), saved.id)).toEqual({ type: 'bearer', token: 'submitted-token' })
  })

  it.each(['add', 'importConfig'] as const)('admits only one synchronous %s submission', async (action) => {
    const { result } = await renderController()
    await act(async () => {
      await Promise.all([result.current.controller[action](), result.current.controller[action]()])
    })
    expect(await getAllMcpServers(getDb())).toHaveLength(1)
  })

  it.each(['resolve', 'reject'] as const)(
    'does not reset or report an old save when reconnect %s after switching forms',
    async (outcome) => {
      await createMcpServer(getDb(), {
        id: 'existing',
        name: 'Existing',
        url: 'https://example.com/mcp',
        type: 'http',
        enabled: 1,
      })
      const pending = Promise.withResolvers<void>()
      const started = Promise.withResolvers<void>()
      const updateLiveServer = mock(() => {
        started.resolve()
        return pending.promise
      })
      const { result, dispatch, servers } = await renderController({ updateLiveServer })
      act(() => result.current.controller.edit(servers[0]))
      const saving = result.current.controller.update()
      await started.promise
      await result.current.controller.update()
      expect(updateLiveServer).toHaveBeenCalledTimes(1)
      act(() => {
        result.current.controller.cancel()
        result.current.form.openAddForm()
        result.current.form.changeUrl('https://replacement.example/mcp')
      })
      dispatch.mockClear()
      await act(async () => {
        if (outcome === 'resolve') {
          pending.resolve()
        } else {
          pending.reject(new Error('old reconnect failed'))
        }
        await saving
      })
      expect(result.current.form.url).toBe('https://replacement.example/mcp')
      expect(result.current.form.isAddFormOpen).toBe(true)
      expect(dispatch).not.toHaveBeenCalled()
    },
  )

  it('does not close a replacement form when old authorization finishes', async () => {
    const pending = Promise.withResolvers<boolean>()
    const authorize = mock(() => pending.promise)
    const { result, dispatch } = await renderController({ startAddAndAuthorize: authorize })
    const saving = result.current.controller.addAndAuthorize()
    await result.current.controller.addAndAuthorize()
    expect(authorize).toHaveBeenCalledTimes(1)
    act(() => {
      result.current.controller.cancel()
      result.current.form.openAddForm()
      result.current.form.changeUrl('https://replacement.example/mcp')
    })
    dispatch.mockClear()
    await act(async () => {
      pending.resolve(true)
      await saving
    })
    expect(result.current.form.url).toBe('https://replacement.example/mcp')
    expect(dispatch).not.toHaveBeenCalled()
  })
})
