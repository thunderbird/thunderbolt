/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { ExternalLinkDialogProvider } from '@/components/chat/markdown-utils'
import { ContentViewProvider } from '@/content-view/context'
import type { SourceMetadata } from '@/types/source'
import { render, fireEvent } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createTestProvider } from '@/test-utils/test-provider'
import { LinkPreviewWidget } from './widget'
import { LinkPreview } from './display'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import type { ReactElement } from 'react'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

const renderWithProviders = (ui: ReactElement) => {
  const TestProvider = createTestProvider()
  return render(ui, {
    wrapper: ({ children }) => (
      <TestProvider>
        <ContentViewProvider>
          <ExternalLinkDialogProvider>{children}</ExternalLinkDialogProvider>
        </ContentViewProvider>
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

describe('LinkPreviewWidget', () => {
  describe('instant render path (source + sources available)', () => {
    it('renders instantly when source index matches a source entry', () => {
      const sources = [makeSource({ index: 1 }), makeSource({ index: 2, title: 'Second Source' })]

      const { getByText } = renderWithProviders(
        <LinkPreviewWidget url="https://example.com/article" source="1" sources={sources} messageId="msg-1" />,
      )

      expect(getByText('Example Article')).toBeTruthy()
      expect(getByText('A great article about testing')).toBeTruthy()
    })

    it('uses O(1) index lookup (sources[sourceIndex - 1])', () => {
      const sources = [
        makeSource({ index: 1, title: 'First' }),
        makeSource({ index: 2, title: 'Second' }),
        makeSource({ index: 3, title: 'Third' }),
      ]

      const { getByText } = renderWithProviders(
        <LinkPreviewWidget url="https://example.com" source="3" sources={sources} messageId="msg-1" />,
      )

      expect(getByText('Third')).toBeTruthy()
    })

    it('loads preview image directly from upstream (no proxy in the path)', () => {
      const sources = [makeSource({ image: 'https://example.com/photo.jpg' })]

      const { container } = renderWithProviders(
        <LinkPreviewWidget url="https://example.com" source="1" sources={sources} messageId="msg-1" />,
      )

      const img = container.querySelector('img')
      expect(img?.getAttribute('src')).toBe('https://example.com/photo.jpg')
    })

    it('renders without image when source has no image', () => {
      const sources = [makeSource({ image: null })]

      const { getByText, container } = renderWithProviders(
        <LinkPreviewWidget url="https://example.com" source="1" sources={sources} messageId="msg-1" />,
      )

      expect(getByText('Example Article')).toBeTruthy()
      expect(container.querySelector('img')).toBeNull()
    })

    it('renders empty description when source has no description', () => {
      const sources = [makeSource({ description: undefined })]

      const { getByText } = renderWithProviders(
        <LinkPreviewWidget url="https://example.com" source="1" sources={sources} messageId="msg-1" />,
      )

      expect(getByText('Example Article')).toBeTruthy()
    })
  })

  describe('fallback path (renders loading skeleton, not instant preview)', () => {
    it('falls back to fetch when source is missing', () => {
      const { container } = renderWithProviders(<LinkPreviewWidget url="https://example.com" messageId="msg-1" />)

      expect(hasSkeleton(container)).toBe(true)
    })

    it('falls back to fetch when sources array is missing', () => {
      const { container } = renderWithProviders(
        <LinkPreviewWidget url="https://example.com" source="1" messageId="msg-1" />,
      )

      expect(hasSkeleton(container)).toBe(true)
    })

    it('falls back to fetch when source index is out of bounds', () => {
      const sources = [makeSource({ index: 1 })]

      const { container } = renderWithProviders(
        <LinkPreviewWidget url="https://example.com" source="99" sources={sources} messageId="msg-1" />,
      )

      expect(hasSkeleton(container)).toBe(true)
    })

    it('falls back to fetch when source data has no title', () => {
      const sources = [{ ...makeSource(), title: '' }]

      const { container } = renderWithProviders(
        <LinkPreviewWidget url="https://example.com" source="1" sources={sources} messageId="msg-1" />,
      )

      expect(hasSkeleton(container)).toBe(true)
    })
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
