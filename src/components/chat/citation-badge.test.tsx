import '@/testing-library'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import { createTestProvider } from '@/test-utils/test-provider'
import { CitationBadge } from './citation-badge'
import type { CitationSource } from '@/types/citation'

const renderWithProviders = (ui: React.ReactElement) => render(ui, { wrapper: createTestProvider() })

describe('CitationBadge', () => {
  it('returns null when sources array is empty', () => {
    const { container } = renderWithProviders(<CitationBadge sources={[]} />)

    expect(container.firstChild).toBeNull()
  })

  it('displays siteName as badge text', () => {
    const { container } = renderWithProviders(
      <CitationBadge
        sources={[{ id: '1', title: 'Article', url: 'https://a.com', siteName: 'Reuters', isPrimary: true }]}
      />,
    )

    expect(container.querySelector('button')?.textContent).toContain('Reuters')
  })

  it('falls back to title when siteName is missing', () => {
    const { container } = renderWithProviders(
      <CitationBadge sources={[{ id: '1', title: 'Some Article', url: 'https://a.com', isPrimary: true }]} />,
    )

    expect(container.querySelector('button')?.textContent).toContain('Some Article')
  })

  it('shows primary source name with +N count for multiple sources', () => {
    const sources: CitationSource[] = [
      { id: '1', title: 'A', url: 'https://a.com', siteName: 'Primary' },
      { id: '2', title: 'B', url: 'https://b.com', siteName: 'Second', isPrimary: true },
      { id: '3', title: 'C', url: 'https://c.com', siteName: 'Third' },
    ]

    const { container } = renderWithProviders(<CitationBadge sources={sources} />)

    const button = container.querySelector('button')
    expect(button?.textContent).toContain('Second')
    expect(button?.textContent).toContain('+2')
  })

  it('uses first source when no primary is marked', () => {
    const sources: CitationSource[] = [
      { id: '1', title: 'First', url: 'https://a.com', siteName: 'First Site' },
      { id: '2', title: 'Second', url: 'https://b.com', siteName: 'Second Site' },
    ]

    const { container } = renderWithProviders(<CitationBadge sources={sources} />)

    expect(container.querySelector('button')?.textContent).toContain('First Site')
  })
})
