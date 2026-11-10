/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import { BrowserFavicon, browserFaviconCandidates } from './browser-favicon'

describe('browser favicons', () => {
  it('uses declared HTTP icons with an origin fallback and excludes privileged schemes or embedded credentials', () => {
    expect(
      browserFaviconCandidates('https://duckduckgo.com/search', [
        'https://duckduckgo.com/icon.svg',
        'file:///icon',
        'data:image/png,x',
        'javascript:alert(1)',
        'https://user:secret@example.com/icon',
      ]),
    ).toEqual(['https://duckduckgo.com/icon.svg', 'https://duckduckgo.com/favicon.ico'])
    expect(browserFaviconCandidates('about:blank')).toEqual([])
  })
  it('tries fallback icons without leaking referrers and replaces failed images with a globe', () => {
    const { container } = render(
      <BrowserFavicon url="https://example.com/page" icons={['https://cdn.example.com/icon.svg']} />,
    )
    const icon = () => container.querySelector('img')!
    expect(icon()).toHaveAttribute('src', 'https://cdn.example.com/icon.svg')
    expect(icon()).toHaveAttribute('referrerpolicy', 'no-referrer')
    fireEvent.error(icon())
    expect(icon()).toHaveAttribute('src', 'https://example.com/favicon.ico')
    fireEvent.error(icon())
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
  })
  it('resets failed candidates when navigation or dynamic icon metadata changes', () => {
    const { container, rerender } = render(<BrowserFavicon url="https://first.example/" />)
    fireEvent.error(container.querySelector('img')!)
    rerender(<BrowserFavicon url="https://second.example/" />)
    expect(container.querySelector('img')).toHaveAttribute('src', 'https://second.example/favicon.ico')
    rerender(<BrowserFavicon url="https://second.example/" icons={['https://second.example/dynamic.png']} />)
    expect(container.querySelector('img')).toHaveAttribute('src', 'https://second.example/dynamic.png')
  })
})
