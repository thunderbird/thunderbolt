/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { render } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createTestProvider } from '@/test-utils/test-provider'
import { CitationBadge } from './citation-badge'
import { CitationPopoverProvider } from './citation-popover'
import { ExternalLinkDialogProvider } from './markdown-utils'
import type { CitationSource } from '@/types/citation'
import { type ReactElement } from 'react'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

// Standalone mode (no provider) — CitationBadge owns its Popover/Sheet
const renderStandalone = (ui: ReactElement) => {
  const TestProvider = createTestProvider()
  return render(ui, {
    wrapper: ({ children }) => (
      <TestProvider>
        <ExternalLinkDialogProvider>{children}</ExternalLinkDialogProvider>
      </TestProvider>
    ),
  })
}

// Managed mode (with provider) — CitationBadge is just a trigger
const renderManaged = (ui: ReactElement) => {
  const TestProvider = createTestProvider()
  return render(ui, {
    wrapper: ({ children }) => (
      <TestProvider>
        <ExternalLinkDialogProvider>
          <CitationPopoverProvider>{children}</CitationPopoverProvider>
        </ExternalLinkDialogProvider>
      </TestProvider>
    ),
  })
}

describe('CitationBadge', () => {
  it('returns null when sources array is empty', () => {
    const { container } = renderStandalone(<CitationBadge sources={[]} />)

    expect(container.firstChild).toBeNull()
  })

  it('displays siteName as badge text (standalone)', () => {
    const { container } = renderStandalone(
      <CitationBadge
        sources={[{ id: '1', title: 'Article', url: 'https://a.com', siteName: 'Reuters', isPrimary: true }]}
      />,
    )

    expect(container.querySelector('button')?.textContent).toContain('Reuters')
  })

  it('displays siteName as badge text (managed)', () => {
    const { container } = renderManaged(
      <CitationBadge
        sources={[{ id: '1', title: 'Article', url: 'https://a.com', siteName: 'Reuters', isPrimary: true }]}
        citationId={0}
      />,
    )

    expect(container.querySelector('button')?.textContent).toContain('Reuters')
  })

  it('falls back to title when siteName is empty', () => {
    const { container } = renderStandalone(
      <CitationBadge
        sources={[{ id: '1', title: 'Fallback Title', url: 'https://a.com', siteName: '', isPrimary: true }]}
      />,
    )

    expect(container.querySelector('button')?.textContent).toContain('Fallback Title')
  })

  it('falls back to title when siteName is missing', () => {
    const { container } = renderStandalone(
      <CitationBadge sources={[{ id: '1', title: 'Only Title', url: 'https://a.com', isPrimary: true }]} />,
    )

    expect(container.querySelector('button')?.textContent).toContain('Only Title')
  })

  it('shows primary source siteName with +N count for multiple sources', () => {
    const sources: CitationSource[] = [
      { id: '1', title: 'First Article', url: 'https://a.com', siteName: 'Site A' },
      { id: '2', title: 'Primary Article', url: 'https://b.com', siteName: 'Site B', isPrimary: true },
      { id: '3', title: 'Third Article', url: 'https://c.com', siteName: 'Site C' },
    ]

    const { container } = renderStandalone(<CitationBadge sources={sources} />)

    const button = container.querySelector('button')
    expect(button?.textContent).toContain('Site B')
    expect(button?.textContent).toContain('+2')
  })

  it('uses first source when no primary is marked', () => {
    const sources: CitationSource[] = [
      { id: '1', title: 'First Article', url: 'https://a.com', siteName: 'First Site' },
      { id: '2', title: 'Second Article', url: 'https://b.com', siteName: 'Second Site' },
    ]

    const { container } = renderStandalone(<CitationBadge sources={sources} />)

    expect(container.querySelector('button')?.textContent).toContain('First Site')
  })
})
