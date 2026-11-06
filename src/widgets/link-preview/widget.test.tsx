/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getClock } from '@/testing-library'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { ExternalLinkDialogProvider } from '@/components/chat/markdown-utils'
import { ContentViewProvider } from '@/content-view/context'
import type { SourceMetadata } from '@/types/source'
import { act, cleanup, render } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import { clearAuthToken, getAuthToken, setAuthToken } from '@/lib/auth-token'
import type { HttpClient } from '@/lib/http'
import { createMockHttpClient, createRecordingClient } from '@/test-utils/http-client'
import { HttpClientProvider } from '@/contexts/http-client-context'
import { getDb } from '@/db/database'
import { chatMessagesTable, chatThreadsTable } from '@/db/tables'
import { createModel } from '@/dal/models'
import { updateSettings } from '@/dal/settings'
import { clearCachedSession } from '@/lib/session-cache'
import * as integrations from '@/dal/integrations'
import * as tinfoilConnection from '@/hooks/use-tinfoil-connection'
import { createTestProvider } from '@/test-utils/test-provider'
import { LinkPreviewWidget } from './widget'
import type { ReactElement } from 'react'

const originalLocalSettings = useLocalSettingsStore.getState()
const originalAuthToken = getAuthToken()
beforeEach(async () => {
  await resetTestDatabase()
  await getDb().insert(chatThreadsTable).values({ id: 'preview-thread' })
  await getDb().insert(chatMessagesTable).values({ id: 'msg-1', chatThreadId: 'preview-thread', role: 'assistant' })
  clearAuthToken()
  useLocalSettingsStore.setState({ cloudUrl: 'https://cloud.example/v1', localMode: false })
  setAuthToken('cloud-account-token')
  await updateSettings(getDb(), { integrations_pro_is_enabled: true })
  useSearchProviderStore.getState().clearSearchProvider()
})
afterEach(() => {
  cleanup()
  useLocalSettingsStore.setState(originalLocalSettings)
  useSearchProviderStore.getState().clearSearchProvider()
  if (originalAuthToken) {
    setAuthToken(originalAuthToken)
  } else {
    clearAuthToken()
  }
})

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

const renderWithProviders = (ui: ReactElement, httpClient: HttpClient = createMockHttpClient()) => {
  const TestProvider = createTestProvider()
  return render(ui, {
    wrapper: ({ children }) => (
      <TestProvider>
        <HttpClientProvider httpClient={httpClient}>
          <ContentViewProvider>
            <ExternalLinkDialogProvider>{children}</ExternalLinkDialogProvider>
          </ContentViewProvider>
        </HttpClientProvider>
      </TestProvider>
    ),
  })
}

const makeSource = (overrides: Partial<SourceMetadata> = {}): SourceMetadata => ({
  index: 1,
  url: 'https://example.com/article',
  title: 'Example Article',
  description: 'A great article about testing',
  image: 'https://example.com/img.png',
  favicon: 'https://example.com/favicon.ico',
  siteName: 'example.com',
  toolName: 'search',
  ...overrides,
})

/** Detects the loading skeleton rendered by the fallback (FetchLinkPreview) path */
const hasSkeleton = (container: HTMLElement) => container.querySelector('[data-slot="skeleton"]') !== null

const previewResponse = JSON.stringify({
  title: 'Server preview',
  summary: null,
  siteName: null,
  previewImageUrl: null,
})
const settleQueries = async () =>
  act(async () => {
    await getClock().runAllAsync()
  })

describe('LinkPreviewWidget', () => {
  describe('instant render path (source + sources available)', () => {
    it('renders instantly when source index matches a source entry', () => {
      const sources = [makeSource({ index: 1 }), makeSource({ index: 2, title: 'Second Source' })]

      const { getByText } = renderWithProviders(
        <LinkPreviewWidget url="https://example.com/article" source="1" sourceMetadata={sources} messageId="msg-1" />,
      )

      expect(getByText('Example Article')).toBeTruthy()
      expect(getByText('A great article about testing')).toBeTruthy()
    })

    it('resolves the recorded source number', () => {
      const sources = [
        makeSource({ index: 1, title: 'First' }),
        makeSource({ index: 2, title: 'Second' }),
        makeSource({ index: 3, title: 'Third' }),
      ]

      const { getByText } = renderWithProviders(
        <LinkPreviewWidget url="https://example.com" source="3" sourceMetadata={sources} messageId="msg-1" />,
      )

      expect(getByText('Third')).toBeTruthy()
    })

    it('loads preview image directly from upstream (no proxy in the path)', () => {
      const sources = [makeSource({ image: 'https://example.com/photo.jpg' })]

      const { container } = renderWithProviders(
        <LinkPreviewWidget url="https://example.com" source="1" sourceMetadata={sources} messageId="msg-1" />,
      )

      const img = container.querySelector('img')
      expect(img?.getAttribute('src')).toBe('https://example.com/photo.jpg')
    })

    it('renders private source metadata without loading the remote preview image', () => {
      const sources = [makeSource({ allowRemoteImages: false })]
      const { container, getByText } = renderWithProviders(
        <LinkPreviewWidget url="https://example.com" source="1" sourceMetadata={sources} messageId="msg-1" />,
      )
      expect(getByText('Example Article')).toBeInTheDocument()
      expect(getByText('A great article about testing')).toBeInTheDocument()
      expect(container.querySelector('img')).toBeNull()
      expect(container.querySelector('a')).toHaveAttribute('href', sources[0].url)
    })

    it.each([undefined, '99'])(
      'uses recorded private metadata without a valid source reference (%s)',
      async (source) => {
        useSearchProviderStore.getState().selectSearchProvider('cloud')
        const { client, requests } = createRecordingClient(() => previewResponse)
        const { container, getByText } = renderWithProviders(
          <LinkPreviewWidget
            url="https://example.com/article#section"
            source={source}
            sourceMetadata={[makeSource({ allowRemoteImages: false })]}
            messageId="msg-1"
          />,
          client,
        )
        await settleQueries()
        expect(getByText('Example Article')).toBeInTheDocument()
        expect(container.querySelector('img')).toBeNull()
        expect(requests).toEqual([])
      },
    )

    it('does not enrich an unrecognized URL from a private message after switching to cloud', async () => {
      useSearchProviderStore.getState().selectSearchProvider('cloud')
      const { client, requests } = createRecordingClient(() => previewResponse)
      const { container, getByText } = renderWithProviders(
        <LinkPreviewWidget
          url="https://different.example/private-query"
          sourceMetadata={[makeSource({ allowRemoteImages: false })]}
          messageId="msg-1"
        />,
        client,
      )
      await settleQueries()
      expect(getByText('different.example')).toBeInTheDocument()
      expect(container.querySelector('img')).toBeNull()
      expect(requests).toEqual([])
    })

    it.each(['http://localhost:8080/icon', 'http://192.168.1.1/icon', 'http://user:pass@example.com/icon'])(
      'does not load unsafe collected preview media %s',
      (image) => {
        const { container } = renderWithProviders(
          <LinkPreviewWidget
            url="https://example.com/article"
            sourceMetadata={[makeSource({ image })]}
            messageId="msg-1"
          />,
        )
        expect(container.querySelector('img')).toBeNull()
      },
    )

    it('renders without image when source has no image', () => {
      const sources = [makeSource({ image: null })]

      const { getByText, container } = renderWithProviders(
        <LinkPreviewWidget url="https://example.com" source="1" sourceMetadata={sources} messageId="msg-1" />,
      )

      expect(getByText('Example Article')).toBeTruthy()
      expect(container.querySelector('img')).toBeNull()
    })

    it('renders empty description when source has no description', () => {
      const sources = [makeSource({ description: undefined })]

      const { getByText } = renderWithProviders(
        <LinkPreviewWidget url="https://example.com" source="1" sourceMetadata={sources} messageId="msg-1" />,
      )

      expect(getByText('Example Article')).toBeTruthy()
    })
  })

  describe('fallback path', () => {
    it.each([
      { name: 'source is missing', source: undefined, sources: undefined },
      { name: 'sources array is missing', source: '1', sources: undefined },
      { name: 'source index is out of bounds', source: '99', sources: [makeSource()] },
    ])('uses the backend for ordinary cloud users when $name', async ({ source, sources }) => {
      const { client, requests } = createRecordingClient(() => previewResponse)
      const { getByText } = renderWithProviders(
        <LinkPreviewWidget
          url="https://example.com"
          source={source}
          sourceMetadata={sources ? [...sources] : undefined}
          messageId="msg-1"
        />,
        client,
      )
      expect(requests).toEqual([])
      await settleQueries()
      expect(requests).toEqual(['preview'])
      expect(getByText('Server preview')).toBeTruthy()
    })

    it('uses known metadata even when the page has no title', async () => {
      const sources = [{ ...makeSource(), title: '' }]
      const { client, requests } = createRecordingClient(() => previewResponse)
      const { container, getByText } = renderWithProviders(
        <LinkPreviewWidget url="https://example.com" source="1" sourceMetadata={sources} messageId="msg-1" />,
        client,
      )
      expect(hasSkeleton(container)).toBe(false)
      expect(getByText('example.com')).toBeTruthy()
      expect(getByText('A great article about testing')).toBeTruthy()
      await settleQueries()
      expect(requests).toEqual([])
    })
  })
})

describe('standalone preview privacy', () => {
  beforeEach(() => {
    clearAuthToken()
    clearCachedSession()
  })
  it.each(['', 'https://waitlist.example/v1'])(
    'uses a hostname fallback without a request for local setup at %s',
    (cloudUrl) => {
      useLocalSettingsStore.setState({ cloudUrl, localMode: true })
      const { container, getByText } = renderWithProviders(
        <LinkPreviewWidget url="https://example.com/article" messageId="msg-1" />,
      )
      expect(hasSkeleton(container)).toBe(false)
      expect(getByText('example.com')).toBeTruthy()
    },
  )

  it('still renders collected source metadata locally', () => {
    useLocalSettingsStore.setState({ cloudUrl: '', localMode: true })
    const { getByText } = renderWithProviders(
      <LinkPreviewWidget
        url="https://example.com/article"
        source="1"
        sourceMetadata={[makeSource()]}
        messageId="source-preview"
      />,
    )
    expect(getByText('Example Article')).toBeTruthy()
    expect(getByText('A great article about testing')).toBeTruthy()
  })

  it('preserves explicitly injected preview behavior in local mode', () => {
    useLocalSettingsStore.setState({ cloudUrl: '', localMode: true })
    const { container } = renderWithProviders(
      <LinkPreviewWidget
        url="https://example.com/article"
        messageId="msg-1"
        fetchPreviewFn={async () => ({ title: 'Injected', summary: null, siteName: null, previewImageUrl: null })}
      />,
    )
    expect(hasSkeleton(container)).toBe(true)
  })
})

describe('cloud-account private-search preview routing', () => {
  it.each(['auto', 'cloud'] as const)(
    'does not fetch previews with the Cloud connection disabled (%s)',
    async (selection) => {
      await updateSettings(getDb(), { integrations_pro_is_enabled: false })
      useSearchProviderStore.getState().selectSearchProvider(selection)
      const { client, requests } = createRecordingClient(() => previewResponse)
      const { getByText } = renderWithProviders(
        <LinkPreviewWidget url="https://example.com/article" messageId="msg-1" />,
        client,
      )
      await settleQueries()
      expect(requests).toEqual([])
      expect(getByText('example.com')).toBeTruthy()
    },
  )

  it.each([true, false])(
    'does not fetch previews without authentication regardless of localMode: %s',
    async (localMode) => {
      clearAuthToken()
      clearCachedSession()
      useLocalSettingsStore.setState({ localMode })
      const { client, requests } = createRecordingClient(() => previewResponse)
      renderWithProviders(<LinkPreviewWidget url="https://example.com/article" messageId="msg-1" />, client)
      await settleQueries()
      expect(requests).toEqual([])
    },
  )

  beforeEach(() => {
    setAuthToken('cloud-account-token')
    useLocalSettingsStore.setState({ cloudUrl: 'https://cloud.example/v1', localMode: true })
  })

  it.each(['tinfoil', 'custom', 'none'] as const)(
    'never sends preview URLs to the server when %s is selected',
    async (selection) => {
      useSearchProviderStore.getState().selectSearchProvider(selection)
      const { client, requests } = createRecordingClient(() => previewResponse)
      const { getByText } = renderWithProviders(
        <LinkPreviewWidget url="https://example.com/private-research" messageId="msg-1" />,
        client,
      )
      await settleQueries()
      expect(requests).toEqual([])
      expect(getByText('example.com')).toBeTruthy()
    },
  )

  it.each(['custom', 'tinfoil-oauth', 'tinfoil-byok'] as const)(
    'keeps automatic %s selection off the server',
    async (provider) => {
      if (provider === 'custom') {
        useSearchProviderStore.getState().configureSearchProvider('own-key', 'exa')
      } else if (provider === 'tinfoil-oauth') {
        await integrations.saveIntegrationCredentials(getDb(), 'tinfoil', { access_token: 'own-token' }, true)
      } else {
        await createModel(getDb(), {
          id: 'tinfoil',
          name: 'Tinfoil',
          provider: 'tinfoil',
          model: 'test',
          apiKey: 'own-key',
          enabled: 1,
        })
      }
      useSearchProviderStore.getState().selectSearchProvider('auto')
      const { client, requests } = createRecordingClient(() => previewResponse)
      renderWithProviders(<LinkPreviewWidget url="https://example.com/private-research" messageId="msg-1" />, client)
      await settleQueries()
      expect(requests).toEqual([])
    },
  )

  it.each([
    { access_token: 'disabled', enabled: false },
    { access_token: '', enabled: false },
    { access_token: 'expired', reauth_required: true, enabled: true },
  ])(
    'keeps automatic selection off the cloud after Tinfoil becomes unavailable: %j',
    async ({ enabled, ...credentials }) => {
      await integrations.saveIntegrationCredentials(getDb(), 'tinfoil', credentials, enabled)
      const { client, requests } = createRecordingClient(() => previewResponse)
      renderWithProviders(<LinkPreviewWidget url="https://example.com/private-research" messageId="msg-1" />, client)
      await settleQueries()
      expect(requests).toEqual([])
    },
  )

  it('allows an explicit cloud choice despite connected private providers', async () => {
    await integrations.saveIntegrationCredentials(getDb(), 'tinfoil', { access_token: 'own-token' }, true)
    useSearchProviderStore.getState().selectSearchProvider('cloud')
    const { client, requests } = createRecordingClient(() => previewResponse)
    renderWithProviders(<LinkPreviewWidget url="https://example.com/article" messageId="msg-1" />, client)
    await settleQueries()
    expect(requests).toEqual(['preview'])
  })

  it('does not infer cloud permission from an unresolved or failed provider lookup', async () => {
    const useConnection = tinfoilConnection.useTinfoilConnection
    const status = { isLoading: true, isFetching: true, isSuccess: false }
    const session = spyOn(tinfoilConnection, 'useTinfoilConnection').mockImplementation(() => ({
      ...useConnection(),
      ...status,
    }))
    try {
      const { client, requests } = createRecordingClient(() => previewResponse)
      const view = renderWithProviders(
        <LinkPreviewWidget url="https://example.com/article" messageId="msg-1" />,
        client,
      )
      await settleQueries()
      expect(requests).toEqual([])
      Object.assign(status, { isLoading: false, isFetching: false })
      view.rerender(<LinkPreviewWidget url="https://example.com/article" messageId="msg-1" />)
      await settleQueries()
      expect(requests).toEqual([])
    } finally {
      session.mockRestore()
    }
  })
})
