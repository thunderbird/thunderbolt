/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getClock } from '@/testing-library'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { ExternalLinkDialogProvider } from '@/components/chat/markdown-utils'
import { ContentViewProvider } from '@/content-view/context'
import type { SourceMetadata } from '@/types/source'
import { act, cleanup, render, fireEvent } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import { clearAuthToken, getAuthToken, setAuthToken } from '@/lib/auth-token'
import type { HttpClient } from '@/lib/http'
import { createMockHttpClient, createRecordingClient } from '@/test-utils/http-client'
import { HttpClientProvider } from '@/contexts/http-client-context'
import { getDb } from '@/db/database'
import { chatMessagesTable, chatThreadsTable } from '@/db/tables'
import {
  saveProviderConnection,
  disconnectProviderConnection,
  updateProviderConnection,
} from '@/dal/provider-connections'
import { updateSettings } from '@/dal/settings'
import { clearCachedSession } from '@/lib/session-cache'
import * as searchAvailability from '@/integrations/standalone-search/use-search-provider-availability'
import { createTestProvider } from '@/test-utils/test-provider'
import { LinkPreviewWidget } from './widget'
import { LinkPreview } from './display'
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

  it.each(['connection', 'none'] as const)('never sends previews to Cloud when %s is selected', async (selection) => {
    if (selection === 'connection') {
      useSearchProviderStore.getState().selectSearchConnection('missing-private-connection')
    } else {
      useSearchProviderStore.getState().selectSearchProvider('none')
    }
    const { client, requests } = createRecordingClient(() => previewResponse)
    renderWithProviders(<LinkPreviewWidget url="https://example.com/private-research" messageId="msg-1" />, client)
    await settleQueries()
    expect(requests).toEqual([])
  })
  it.each(['exa', 'tinfoil', 'otari'] as const)(
    'keeps selected %s connection previews off Cloud without any model',
    async (provider) => {
      const id = await saveProviderConnection(getDb(), {
        provider,
        name: 'Private',
        url: provider === 'otari' ? 'https://otari.example/api/v1' : null,
        authMethod: 'api_key',
        credentials: { apiKey: 'key' },
      })
      useSearchProviderStore.getState().selectSearchConnection(id)
      const { client, requests } = createRecordingClient(() => previewResponse)
      renderWithProviders(<LinkPreviewWidget url="https://example.com/private-research" messageId="msg-1" />, client)
      await settleQueries()
      expect(requests).toEqual([])
    },
  )
  it.each(['disabled', 'disconnected'] as const)(
    'does not fall back to Cloud after a selected connection is %s',
    async (change) => {
      const id = await saveProviderConnection(getDb(), {
        provider: 'tinfoil',
        name: 'Private',
        authMethod: 'api_key',
        credentials: { apiKey: 'key' },
      })
      useSearchProviderStore.getState().selectSearchConnection(id)
      if (change === 'disabled') {
        await updateProviderConnection(getDb(), id, { enabled: false })
      } else {
        await disconnectProviderConnection(getDb(), id)
      }
      const { client, requests } = createRecordingClient(() => previewResponse)
      renderWithProviders(<LinkPreviewWidget url="https://example.com/private-research" messageId="msg-1" />, client)
      await settleQueries()
      expect(requests).toEqual([])
    },
  )
  it('allows an explicit Cloud choice despite an unused private connection', async () => {
    await saveProviderConnection(getDb(), {
      provider: 'tinfoil',
      name: 'Private',
      authMethod: 'api_key',
      credentials: { apiKey: 'key' },
    })
    useSearchProviderStore.getState().selectSearchProvider('cloud')
    const { client, requests } = createRecordingClient(() => previewResponse)
    renderWithProviders(<LinkPreviewWidget url="https://example.com/article" messageId="msg-1" />, client)
    await settleQueries()
    expect(requests).toEqual(['preview'])
  })

  it('does not infer cloud permission from an unresolved or failed provider lookup', async () => {
    const useConnection = searchAvailability.useSearchProviderAvailability
    const status = { loading: true, ready: false }
    const session = spyOn(searchAvailability, 'useSearchProviderAvailability').mockImplementation(() => ({
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
      Object.assign(status, { loading: false, ready: false })
      view.rerender(<LinkPreviewWidget url="https://example.com/article" messageId="msg-1" />)
      await settleQueries()
      expect(requests).toEqual([])
    } finally {
      session.mockRestore()
    }
  })
})

describe('link preview image lifecycle', () => {
  it('loads a replacement image after the previous image failed', () => {
    const props = { title: 'Article', description: null, url: 'https://example.com' }
    const { container, rerender } = renderWithProviders(<LinkPreview {...props} image="https://example.com/old.png" />)
    fireEvent.error(container.querySelector('img')!)
    expect(container.querySelector('img')).toBeNull()
    rerender(<LinkPreview {...props} image="https://example.com/new.png" />)
    const image = container.querySelector('img')!
    expect(image.src).toBe('https://example.com/new.png')
    expect(image.className).toContain('opacity-0')
    fireEvent.load(image)
    expect(image.className).toContain('opacity-100')
  })

  it('starts loading when an image arrives after a preview without one', () => {
    const props = { title: 'Article', description: null, url: 'https://example.com' }
    const { container, rerender } = renderWithProviders(<LinkPreview {...props} image={null} />)
    rerender(<LinkPreview {...props} image="https://example.com/new.png" />)
    expect(container.querySelector('img')!.className).toContain('opacity-0')
  })
})

describe('link preview navigation', () => {
  it.each([
    ['https://example.com', true],
    ['javascript:alert(1)', false],
  ])('handles %s through the safe link boundary', (url, safe) => {
    const previous = useLocalSettingsStore.getState().externalLinkBehavior
    useLocalSettingsStore.setState({ externalLinkBehavior: 'ask' })
    try {
      const { getByRole, queryByRole } = renderWithProviders(
        <LinkPreview title="Article" description={null} image={null} url={url} />,
      )
      const link = getByRole('link')
      expect(link.getAttribute('href')).toBe(safe ? url : '#')
      expect(link.getAttribute('rel')).toBe('noopener noreferrer')
      expect(fireEvent.click(link)).toBe(false)
      expect(queryByRole('alertdialog') !== null).toBe(safe)
    } finally {
      useLocalSettingsStore.setState({ externalLinkBehavior: previous })
    }
  })
})
