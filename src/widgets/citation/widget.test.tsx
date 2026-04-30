/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { render } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { ExternalLinkDialogProvider } from '@/components/chat/markdown-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import { CitationWidgetComponent } from './widget'
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
        <ExternalLinkDialogProvider>{children}</ExternalLinkDialogProvider>
      </TestProvider>
    ),
  })
}

describe('CitationWidgetComponent', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })
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
