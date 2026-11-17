/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'bun:test'
import { reloadFailedStylesheets } from './retryable-lazy'

/** What a browser reports as a link's `sheet` once it loaded or failed. Only `cssRules` is read. */
type ReportedSheet = { readonly cssRules: readonly object[] } | null

/** A stylesheet link whose `sheet` is what a browser reports after the load. */
const addStylesheet = (href: string, sheet: () => ReportedSheet) => {
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = href
  Object.defineProperty(link, 'sheet', { get: sheet })
  document.head.appendChild(link)
  return link
}

describe('reloadFailedStylesheets', () => {
  afterEach(() => {
    document.head.innerHTML = ''
  })

  it('swaps only the stylesheets that did not load for fresh copies', () => {
    const loaded = addStylesheet('/assets/loaded.css', () => ({ cssRules: [{}] }))
    // Chromium refuses to read a failed sheet's rules. The other shapes a failure can take: no rules, or no sheet.
    addStylesheet('/assets/unreadable.css', () => ({
      get cssRules(): readonly object[] {
        throw new DOMException('Cannot access rules', 'SecurityError')
      },
    }))
    addStylesheet('/assets/empty.css', () => ({ cssRules: [] }))
    addStylesheet('/assets/missing.css', () => null)

    reloadFailedStylesheets()

    const links = [...document.head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/assets/loaded.css',
      '/assets/unreadable.css',
      '/assets/empty.css',
      '/assets/missing.css',
    ])
    expect(links[0]).toBe(loaded)
    // The copies are new elements, without the stubbed `sheet`, so the browser fetches them again.
    expect(links.slice(1).every((link) => !Object.hasOwn(link, 'sheet'))).toBe(true)
  })
})
