/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, type Mock, mock, spyOn } from 'bun:test'
import { type ComponentType, createElement, Suspense } from 'react'
import { getClock } from '@/testing-library'
import { reloadFailedStylesheets, retryableLazy } from './retryable-lazy'
import { ViewerErrorBoundary } from './viewer-error-boundary'

const flush = () => act(async () => void (await getClock().tickAsync(20)))

/** The fresh copy of a stylesheet that did not load, which the browser is fetching again. */
const stylesheetCopy = () => document.head.querySelector<HTMLLinkElement>('link[rel="stylesheet"]')!

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

  it('resolves right away when nothing failed, and otherwise once the copy loads', async () => {
    expect(await reloadFailedStylesheets()).toEqual([])

    addStylesheet('/assets/viewer.css', () => null)
    let settled = false
    const reloaded = reloadFailedStylesheets().then(() => (settled = true))
    await flush()
    expect(settled).toBe(false)

    stylesheetCopy().dispatchEvent(new Event('load'))
    await reloaded

    expect(settled).toBe(true)
  })
})

describe('retryableLazy', () => {
  let consoleError: Mock<typeof console.error>

  beforeEach(() => {
    consoleError = spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    document.head.innerHTML = ''
    consoleError.mockRestore()
  })

  /** Renders the component the getter hands out now, as the side view does on each attempt. */
  const show = (component: ComponentType) =>
    render(
      createElement(ViewerErrorBoundary, {
        fallback: 'failed',
        children: createElement(Suspense, { fallback: 'loading' }, createElement(component)),
      }),
    )

  it('waits for a failed stylesheet on a retry, and fails the attempt when it fails again', async () => {
    const load = mock(async () => ({ default: () => 'viewer' }))
    load.mockImplementationOnce(async () => {
      throw new Error('Failed to fetch dynamically imported module')
    })
    const viewer = retryableLazy(load)
    addStylesheet('/assets/viewer.css', () => null)
    show(viewer())
    await flush()
    expect(screen.getByText('failed')).toBeInTheDocument()
    cleanup()

    const retried = viewer()
    show(retried)
    await flush()
    // The chunk loaded, but its stylesheet is still on the way.
    expect(screen.getByText('loading')).toBeInTheDocument()
    stylesheetCopy().dispatchEvent(new Event('error'))
    await flush()
    expect(screen.getByText('failed')).toBeInTheDocument()
    cleanup()

    expect(viewer()).not.toBe(retried)
    show(viewer())
    await flush()
    stylesheetCopy().dispatchEvent(new Event('load'))
    await flush()
    expect(screen.getByText('viewer')).toBeInTheDocument()
  })
})
