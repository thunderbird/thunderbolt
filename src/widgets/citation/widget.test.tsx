import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { createTestProvider } from '@/test-utils/test-provider'
import { CitationWidgetComponent } from './widget'

// Clean up after each test
afterEach(() => {
  cleanup()
})

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

      renderWithProviders(<CitationWidgetComponent sources={sources} />)

      expect(screen.getByText('Example')).toBeTruthy()
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

      renderWithProviders(<CitationWidgetComponent sources={sources} />)

      expect(screen.getByText('Example')).toBeTruthy()
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
      const sources = btoa(json) // Base64 encode

      renderWithProviders(<CitationWidgetComponent sources={sources} />)

      expect(screen.getByText('Primary Site')).toBeTruthy()
      expect(screen.getByText('+1')).toBeTruthy()
    })

    it('returns null for malformed base64', () => {
      const sources = 'not valid base64!!!'

      const { container } = renderWithProviders(<CitationWidgetComponent sources={sources} />)

      expect(container.firstChild).toBeNull()
    })

    it('returns null for empty sources array', () => {
      const sources = btoa('[]') // Base64 encode empty array

      const { container } = renderWithProviders(<CitationWidgetComponent sources={sources} />)

      expect(container.firstChild).toBeNull()
    })

    it('returns null for non-array JSON', () => {
      const sources = btoa('{"id":"1"}') // Base64 encode object

      const { container } = renderWithProviders(<CitationWidgetComponent sources={sources} />)

      expect(container.firstChild).toBeNull()
    })
  })

  describe('error handling', () => {
    it('handles JSON parse errors gracefully', () => {
      const sources = btoa('{broken json') // Base64 encode invalid JSON

      // Should not throw
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
      const sources = btoa(json) // Base64 encode

      renderWithProviders(<CitationWidgetComponent sources={sources} />)

      // Should still render even if optional fields are missing
      expect(screen.getByText('Test')).toBeTruthy()
    })
  })
})
