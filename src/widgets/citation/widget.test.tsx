import '@/testing-library'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import { createTestProvider } from '@/test-utils/test-provider'
import { CitationWidgetComponent } from './widget'

const renderWithProviders = (ui: React.ReactElement) => render(ui, { wrapper: createTestProvider() })

describe('CitationWidgetComponent', () => {
  describe('rendering', () => {
    it('renders CitationBadge with raw JSON sources', () => {
      const sources = JSON.stringify([
        {
          id: 'src-1',
          title: 'Test Article',
          url: 'https://example.com',
          siteName: 'Example',
          isPrimary: true,
        },
      ])

      const { container } = renderWithProviders(<CitationWidgetComponent sources={sources} />)

      expect(container.querySelector('button')?.textContent).toContain('Example')
    })

    it('renders CitationBadge with base64-encoded sources (backward compat)', () => {
      const json = JSON.stringify([
        {
          id: 'src-1',
          title: 'Test Article',
          url: 'https://example.com',
          siteName: 'Example',
          isPrimary: true,
        },
      ])
      const sources = btoa(json)

      const { container } = renderWithProviders(<CitationWidgetComponent sources={sources} />)

      expect(container.querySelector('button')?.textContent).toContain('Example')
    })

    it('renders multiple sources correctly', () => {
      const json = JSON.stringify([
        {
          id: 'src-1',
          title: 'Primary Article',
          url: 'https://example.com/primary',
          siteName: 'Primary Site',
          isPrimary: true,
        },
        {
          id: 'src-2',
          title: 'Second Article',
          url: 'https://example.com/second',
          siteName: 'Second Site',
        },
      ])
      const sources = btoa(json)

      const { container } = renderWithProviders(<CitationWidgetComponent sources={sources} />)

      expect(container.querySelector('button')?.textContent).toContain('Primary Site')
      expect(container.querySelector('button')?.textContent).toContain('+1')
    })

    it('returns null for malformed base64', () => {
      const sources = 'not valid base64!!!'

      const { container } = renderWithProviders(<CitationWidgetComponent sources={sources} />)

      expect(container.firstChild).toBeNull()
    })

    it('returns null for empty sources array', () => {
      const sources = btoa('[]')

      const { container } = renderWithProviders(<CitationWidgetComponent sources={sources} />)

      expect(container.firstChild).toBeNull()
    })

    it('returns null for non-array JSON', () => {
      const sources = btoa('{"id":"1"}')

      const { container } = renderWithProviders(<CitationWidgetComponent sources={sources} />)

      expect(container.firstChild).toBeNull()
    })
  })

  describe('error handling', () => {
    it('handles JSON parse errors gracefully', () => {
      const sources = btoa('{broken json')

      const { container } = renderWithProviders(<CitationWidgetComponent sources={sources} />)

      expect(container.firstChild).toBeNull()
    })

    it('handles sources with missing required fields', () => {
      const json = JSON.stringify([
        {
          id: 'src-1',
          title: 'Test',
          url: 'https://example.com',
        },
      ])
      const sources = btoa(json)

      const { container } = renderWithProviders(<CitationWidgetComponent sources={sources} />)

      expect(container.querySelector('button')?.textContent).toContain('Test')
    })
  })
})
