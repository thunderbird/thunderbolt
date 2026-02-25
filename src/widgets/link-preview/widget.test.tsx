import '@/testing-library'
import { ContentViewProvider } from '@/content-view/context'
import type { SourceMetadata } from '@/types/source'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import { createTestProvider } from '@/test-utils/test-provider'
import { LinkPreviewWidget } from './widget'

const renderWithProviders = (ui: React.ReactElement) => {
  const TestProvider = createTestProvider()
  return render(ui, {
    wrapper: ({ children }) => (
      <TestProvider>
        <ContentViewProvider>{children}</ContentViewProvider>
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

    it('proxies image URL through cloud proxy', () => {
      const sources = [makeSource({ image: 'https://example.com/photo.jpg' })]

      const { container } = renderWithProviders(
        <LinkPreviewWidget url="https://example.com" source="1" sources={sources} messageId="msg-1" />,
      )

      const img = container.querySelector('img')
      expect(img?.getAttribute('src')).toContain('/pro/link-preview/proxy-image/')
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
