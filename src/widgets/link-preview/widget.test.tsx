import '@/testing-library'
import type { SourceMetadata } from '@/types/source'
import { render } from '@testing-library/react'
import { describe, expect, it, mock } from 'bun:test'
import { createTestProvider } from '@/test-utils/test-provider'
import { LinkPreviewWidget } from './widget'

// Mock useMessageCache to avoid actual DB/network calls in fallback path
mock.module('@/hooks/use-message-cache', () => ({
  useMessageCache: () => ({
    data: { title: 'Fetched Title', description: 'Fetched description', image: null },
    isLoading: false,
    error: null,
  }),
}))

// Mock usePreview used by the display component
mock.module('@/content-view/context', () => ({
  usePreview: () => ({ showPreview: () => {} }),
}))

// Mock platform check used by display component
mock.module('@/lib/platform', () => ({
  isDesktop: () => false,
}))

const renderWithProviders = (ui: React.ReactElement) => render(ui, { wrapper: createTestProvider() })

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

    it('proxies image URL through cloud proxy', () => {
      const sources = [makeSource({ image: 'https://example.com/photo.jpg' })]

      const { container } = renderWithProviders(
        <LinkPreviewWidget url="https://example.com" source="1" sources={sources} messageId="msg-1" />,
      )

      const img = container.querySelector('img')
      expect(img?.getAttribute('src')).toContain('/pro/proxy/')
      expect(img?.getAttribute('src')).toContain(encodeURIComponent('https://example.com/photo.jpg'))
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

  describe('fallback path', () => {
    it('falls back to fetch when source is missing', () => {
      const { getByText } = renderWithProviders(<LinkPreviewWidget url="https://example.com" messageId="msg-1" />)

      expect(getByText('Fetched Title')).toBeTruthy()
    })

    it('falls back to fetch when sources array is missing', () => {
      const { getByText } = renderWithProviders(
        <LinkPreviewWidget url="https://example.com" source="1" messageId="msg-1" />,
      )

      expect(getByText('Fetched Title')).toBeTruthy()
    })

    it('falls back to fetch when source index is out of bounds', () => {
      const sources = [makeSource({ index: 1 })]

      const { getByText } = renderWithProviders(
        <LinkPreviewWidget url="https://example.com" source="99" sources={sources} messageId="msg-1" />,
      )

      expect(getByText('Fetched Title')).toBeTruthy()
    })

    it('falls back to fetch when source data has no title', () => {
      const sources = [{ ...makeSource(), title: '' }]

      const { getByText } = renderWithProviders(
        <LinkPreviewWidget url="https://example.com" source="1" sources={sources} messageId="msg-1" />,
      )

      expect(getByText('Fetched Title')).toBeTruthy()
    })
  })
})
