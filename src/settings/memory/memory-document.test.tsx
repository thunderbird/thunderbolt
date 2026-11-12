/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { render, screen } from '@testing-library/react'
import { ExternalLinkDialogProvider } from '@/components/chat/markdown-utils'
import { MemoryDocument } from './memory-document'

describe('Memory document', () => {
  it('renders headings, lists, emphasis, and code as styled content', () => {
    render(
      <MemoryDocument content={'# Preferences\n\n- Prefer **concise** answers.\n- Use `bun`.\n\nKeep *exceptions*.'} />,
    )
    expect(screen.getByRole('heading', { name: 'Preferences' }).tagName).toBe('H1')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText('concise').tagName).toBe('STRONG')
    expect(screen.getByText('bun').tagName).toBe('CODE')
    expect(screen.getByText('exceptions').tagName).toBe('EM')
  })

  it('uses safe links without loading embedded images or executing raw HTML', () => {
    const { container } = render(
      <ExternalLinkDialogProvider>
        <MemoryDocument
          content={[
            '![Report](https://example.invalid/tracker)',
            '[Unsafe](javascript:alert%281%29)',
            '[Reference](https://example.invalid/reference)',
            '<iframe src="https://example.invalid/embed"></iframe>',
          ].join('\n\n')}
        />
      </ExternalLinkDialogProvider>,
    )
    expect(screen.getByText('Report')).toBeVisible()
    expect(screen.getByText('Unsafe').tagName).toBe('SPAN')
    expect(screen.getByRole('link', { name: 'Reference' })).toHaveAttribute('href', 'https://example.invalid/reference')
    expect(container.querySelector('img,iframe,script,[src]')).toBeNull()
  })
})
