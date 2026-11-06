/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { getProviderConnection, saveProviderConnection, disconnectProviderConnection } from '@/dal/provider-connections'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { http } from '@/lib/http'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import { stubJsonResponse } from '@/test-utils/http'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { getClock } from '@/testing-library'
import { ProviderConnectionDetail } from './provider-connection-detail'
import type { useAiProviderConnections } from './use-ai-provider-connections'

const controls: ReturnType<typeof useAiProviderConnections> = {
  providers: [],
  ready: true,
  pending: false,
  error: null,
  toggle: () => {},
  pendingDisable: undefined,
  cancelDisable: () => {},
  confirmDisable: () => {},
  rename: () => {},
  disconnect: () => {},
}
const authorization = { authorize: async () => {}, cancel: () => {}, isPending: false, error: null, manual: null }

describe('provider connection detail', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  beforeEach(async () => {
    await resetTestDatabase()
    useSearchProviderStore.getState().clearSearchProvider()
  })
  afterEach(() => {
    cleanup()
    mock.restore()
    useSearchProviderStore.getState().clearSearchProvider()
  })

  it.each(['initially disconnected', 'disconnected while open'] as const)(
    'finishes reconnect discovery when live metadata becomes connected: %s',
    async (scenario) => {
      const id = await saveProviderConnection(getDb(), {
        provider: 'otari',
        name: 'Workspace',
        authMethod: 'api_key',
        credentials: { apiKey: 'old-key' },
      })
      const connected = (await getProviderConnection(getDb(), id))!
      await disconnectProviderConnection(getDb(), id)
      const disconnected = (await getProviderConnection(getDb(), id))!
      const detail = (connection: typeof connected) => (
        <ProviderConnectionDetail
          connection={connection}
          controls={controls}
          authorization={authorization}
          onClose={() => {}}
        />
      )
      const view = renderWithReactivity(detail(scenario === 'initially disconnected' ? disconnected : connected), {
        route: '/settings/connections',
      })
      if (scenario === 'disconnected while open') {
        view.rerender(detail(disconnected))
      }
      const started = Promise.withResolvers<void>()
      const response = Promise.withResolvers<unknown>()
      const request = stubJsonResponse(null)
      request.json = <T,>() => response.promise as Promise<T>
      const get = spyOn(http, 'get').mockImplementation(() => {
        started.resolve()
        return request
      })
      fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'new-key' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
      await act(async () => started.promise)

      // PowerSync can publish the committed credentials before discovery completes.
      view.rerender(detail((await getProviderConnection(getDb(), id))!))
      expect(get.mock.calls[0][1]?.signal?.aborted).toBe(false)
      await act(async () => {
        response.resolve({ data: [{ id: 'otari_web_search', direct_available: true }] })
        await getClock().runAllAsync()
      })

      expect(await waitForElement(() => screen.queryByRole('button', { name: 'Update credentials' }))).toBeVisible()
      expect(useSearchProviderStore.getState().connectionStatus).toEqual({ connectionId: id, status: 'available' })
      expect(screen.queryByLabelText('API key')).toBeNull()
    },
  )
})
