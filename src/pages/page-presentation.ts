/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { pageSlots } from './page-slot'
import { usePageStore } from './page-store'

const pause = (signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, 16)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      abort()
    }
  })

/** React placement and native presentation must agree before an observation or pointer action. */
export const waitForPagePresentation = async (id: string, signal?: AbortSignal): Promise<void> => {
  const deadline = Date.now() + 5000
  // Let a just-selected tab commit before testing its permanent host's old geometry.
  await pause(signal)
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    const state = usePageStore.getState()
    const session = state.sessions.find((item) => item.id === id)
    if (!session) {
      throw new Error('Page session is closed. List pages again.')
    }
    // A blank page intentionally has no visible native surface or DOM page slot.
    if (session.page.source.kind === 'url' && session.browser.url === 'about:blank') {
      return
    }
    const slot = pageSlots.get(id, session.presentation)?.element
    const host = [...document.querySelectorAll<HTMLElement>('[data-page-host]')].find(
      (element) => element.dataset.pageHost === id,
    )
    const active = session.presentation === 'inline' || state.activeId === id
    if (
      active &&
      slot?.isConnected &&
      host?.isConnected &&
      host.getAttribute('aria-hidden') === 'false' &&
      !host.inert &&
      getComputedStyle(host).visibility !== 'hidden'
    ) {
      const expected = slot.getBoundingClientRect()
      const actual = host.getBoundingClientRect()
      if (
        actual.width > 0 &&
        actual.height > 0 &&
        [
          [actual.x, expected.x],
          [actual.y, expected.y],
          [actual.width, expected.width],
          [actual.height, expected.height],
        ].every(([actual, expected]) => Math.abs(actual - expected) < 1)
      ) {
        return
      }
    }
    await pause(signal)
  }
  throw new Error('Page is hidden or covered. Close the covering panel and try again.')
}
