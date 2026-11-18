/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { type ComponentType, createElement, Suspense } from 'react'
import { getClock } from '@/testing-library'
import { importWhenReachable, reloadFailedStylesheets, retryableLazy } from './retryable-lazy'
import { ViewerErrorBoundary } from './viewer-error-boundary'

const flush = () => act(async () => void (await getClock().tickAsync(20)))

/** The app's server as the check before an import sees it: up, answering with an error, or not there at all. */
const stubServer = (answer: 'up' | 'error' | 'down') => {
  const server = spyOn(globalThis, 'fetch')
  return answer === 'down'
    ? server.mockRejectedValue(new TypeError('Load failed'))
    : server.mockResolvedValue(new Response(null, { status: answer === 'up' ? 200 : 503 }))
}

describe('importWhenReachable', () => {
  afterEach(() => mock.restore())

  it.each(['down', 'error'] as const)(
    'never imports while the server is %s, and imports once it is up',
    async (answer) => {
      const load = mock(async () => 'module')
      const loadWhenReachable = importWhenReachable(load)
      const server = stubServer(answer)
      await expect(loadWhenReachable()).rejects.toThrow()
      expect(load).not.toHaveBeenCalled()

      stubServer('up')
      expect(await loadWhenReachable()).toBe('module')
      expect(await loadWhenReachable()).toBe('module')
      // One check while it was not up and one once it was: after the import loaded, it does not ask again.
      expect(server).toHaveBeenCalledTimes(2)
      expect(load).toHaveBeenCalledTimes(1)
    },
  )

  it('checks and imports again after the import failed', async () => {
    const load = mock(async () => 'module')
    load.mockImplementationOnce(async () => {
      throw new Error('Importing a module script failed.')
    })
    const loadWhenReachable = importWhenReachable(load)
    const server = stubServer('up')
    await expect(loadWhenReachable()).rejects.toThrow('Importing a module script failed.')

    expect(await loadWhenReachable()).toBe('module')
    expect(server).toHaveBeenCalledTimes(2)
  })
})

/** The page's only stylesheet: once a retry swapped it, the fresh copy the browser is fetching again. */
const stylesheetCopy = () => document.head.querySelector<HTMLLinkElement>('link[rel="stylesheet"]')!

/** A stylesheet link as Vite's preload helper adds it. */
const addStylesheet = (href: string) => {
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = href
  document.head.appendChild(link)
  return link
}

/** A stylesheet link that fired error, as a browser does when the fetch fails. */
const addFailedStylesheet = (href: string) => {
  const link = addStylesheet(href)
  link.dispatchEvent(new Event('error'))
  return link
}

describe('reloadFailedStylesheets', () => {
  afterEach(() => {
    document.head.innerHTML = ''
  })

  it('swaps only the stylesheets that fired error for fresh copies', () => {
    const loaded = addStylesheet('/assets/loaded.css')
    loaded.dispatchEvent(new Event('load'))
    // Still loading, so something may be waiting on its load event.
    const loading = addStylesheet('/assets/loading.css')
    const failed = addFailedStylesheet('/assets/failed.css')

    reloadFailedStylesheets()

    const links = [...document.head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/assets/loaded.css',
      '/assets/loading.css',
      '/assets/failed.css',
    ])
    expect(links[0]).toBe(loaded)
    expect(links[1]).toBe(loading)
    expect(links[2]).not.toBe(failed)
  })

  it('resolves right away when nothing failed, and otherwise once the copy loads', async () => {
    addStylesheet('/assets/loading.css')
    expect(await reloadFailedStylesheets()).toEqual([])
    document.head.innerHTML = ''

    addFailedStylesheet('/assets/viewer.css')
    let settled = false
    const reloaded = reloadFailedStylesheets().then(() => (settled = true))
    await flush()
    expect(settled).toBe(false)

    stylesheetCopy().dispatchEvent(new Event('load'))
    await reloaded

    expect(settled).toBe(true)
  })

  it.each<[string, PromiseSettledResult<unknown>['status']]>([
    ['load', 'fulfilled'],
    ['error', 'rejected'],
  ])('settles a second call on the copy still loading when it fires %s', async (event, status) => {
    addFailedStylesheet('/assets/viewer.css')
    const outcomes: PromiseSettledResult<unknown>[][] = []
    void Promise.allSettled([reloadFailedStylesheets(), reloadFailedStylesheets()]).then((results) =>
      outcomes.push(results),
    )

    stylesheetCopy().dispatchEvent(new Event(event))
    await flush()

    expect(outcomes[0]?.map((outcome) => outcome.status)).toEqual([status, status])
  })

  it('swaps a copy that failed again on the next call', async () => {
    addFailedStylesheet('/assets/viewer.css')
    const first = reloadFailedStylesheets()
    const failedCopy = stylesheetCopy()
    failedCopy.dispatchEvent(new Event('error'))
    await expect(first).rejects.toThrow('Stylesheet failed to load')

    const second = reloadFailedStylesheets()
    expect(stylesheetCopy()).not.toBe(failedCopy)
    stylesheetCopy().dispatchEvent(new Event('load'))

    expect(await second).toEqual([undefined])
  })

  it('fetches a stylesheet again when the copy still loading left the page', async () => {
    addFailedStylesheet('/assets/viewer.css')
    void reloadFailedStylesheets()
    stylesheetCopy().remove()
    addFailedStylesheet('/assets/viewer.css')

    const reloaded = reloadFailedStylesheets()
    stylesheetCopy().dispatchEvent(new Event('load'))

    expect(await reloaded).toEqual([undefined])
  })
})

describe('retryableLazy', () => {
  beforeEach(() => {
    spyOn(console, 'error').mockImplementation(() => {})
    stubServer('up')
  })

  afterEach(() => {
    cleanup()
    document.head.innerHTML = ''
    mock.restore()
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
    const failed = addFailedStylesheet('/assets/viewer.css')
    show(viewer())
    await flush()
    expect(screen.getByText('failed')).toBeInTheDocument()
    // Only a retry fetches stylesheets again.
    expect(stylesheetCopy()).toBe(failed)
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
