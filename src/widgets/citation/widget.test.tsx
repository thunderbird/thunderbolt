import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { CitationWidgetComponent } from './widget'

// Clean up after each test
afterEach(() => {
  cleanup()
})

describe('CitationWidgetComponent', () => {
  const mockMessageId = 'test-message-id'

  describe('rendering', () => {
    it('renders CitationBadge with parsed sources', () => {
      const json = JSON.stringify([
        {
          id: 'src-1',
          title: 'Test Article',
          url: 'https://example.com',
          siteName: 'Example',
          isPrimary: true,
        },
      ])
      const sources = btoa(json) // Base64 encode

      render(<CitationWidgetComponent sources={sources} messageId={mockMessageId} />)

      expect(screen.getByText('[Example]')).toBeTruthy()
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

      render(<CitationWidgetComponent sources={sources} messageId={mockMessageId} />)

      expect(screen.getByText('[Primary Site +1]')).toBeTruthy()
    })

    it('returns null for malformed base64', () => {
      const sources = 'not valid base64!!!'

      const { container } = render(<CitationWidgetComponent sources={sources} messageId={mockMessageId} />)

      expect(container.firstChild).toBeNull()
    })

    it('returns null for empty sources array', () => {
      const sources = btoa('[]') // Base64 encode empty array

      const { container } = render(<CitationWidgetComponent sources={sources} messageId={mockMessageId} />)

      expect(container.firstChild).toBeNull()
    })

    it('returns null for non-array JSON', () => {
      const sources = btoa('{"id":"1"}') // Base64 encode object

      const { container } = render(<CitationWidgetComponent sources={sources} messageId={mockMessageId} />)

      expect(container.firstChild).toBeNull()
    })
  })

  describe('error handling', () => {
    it('handles JSON parse errors gracefully', () => {
      const sources = btoa('{broken json') // Base64 encode invalid JSON

      // Should not throw
      const { container } = render(<CitationWidgetComponent sources={sources} messageId={mockMessageId} />)

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

      render(<CitationWidgetComponent sources={sources} messageId={mockMessageId} />)

      // Should still render even if optional fields are missing
      expect(screen.getByText('[Test]')).toBeTruthy()
    })
  })
})
