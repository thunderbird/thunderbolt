/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, expect, it, spyOn } from 'bun:test'
import { getClock } from '@/testing-library'
import { pageSlots } from './page-slot'
import { usePageStore } from './page-store'
import { waitForPagePresentation } from './page-presentation'

const disposals: (() => void)[] = []
afterEach(() => {
  disposals.splice(0).forEach((dispose) => dispose())
  usePageStore.setState({ sessions: [], activeId: null })
})
const setup = () => {
  const id = usePageStore
    .getState()
    .ensure({ id: crypto.randomUUID(), title: 'Page', source: { kind: 'url', url: 'https://example.com' } })
  const slot = document.createElement('div')
  const host = document.createElement('div')
  host.dataset.pageHost = id
  host.setAttribute('aria-hidden', 'false')
  document.body.append(slot, host)
  const location = new DOMRect(100, 200, 400, 300)
  const slotRect = spyOn(slot, 'getBoundingClientRect').mockReturnValue(location)
  const hostRect = spyOn(host, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1, 1))
  const getSlot = spyOn(pageSlots, 'get').mockReturnValue({ element: slot, mode: 'sidebar' })
  disposals.push(() => {
    slot.remove()
    host.remove()
    slotRect.mockRestore()
    hostRect.mockRestore()
    getSlot.mockRestore()
  })
  return { id, host, hostRect, location }
}
it('waits for the visible permanent host to match the selected slot geometry', async () => {
  const { id, hostRect, location } = setup()
  let ready = false
  const pending = waitForPagePresentation(id).then(() => {
    ready = true
  })
  await getClock().tickAsync(48)
  expect(ready).toBe(false)
  hostRect.mockReturnValue(location)
  await getClock().tickAsync(16)
  await pending
  expect(ready).toBe(true)
})
it('does not accept matching geometry while a modal hides the page and aborts immediately on Stop', async () => {
  const { id, host, hostRect, location } = setup()
  hostRect.mockReturnValue(location)
  host.setAttribute('aria-hidden', 'true')
  const abort = new AbortController()
  const pending = waitForPagePresentation(id, abort.signal)
  void pending.catch(() => {})
  await getClock().tickAsync(48)
  abort.abort(new Error('Stopped'))
  await expect(pending).rejects.toThrow('Stopped')
})
it('allows intentionally hidden new-tab pages without inventing a viewport slot', async () => {
  const id = usePageStore.getState().ensure({ id: 'blank', title: '', source: { kind: 'url', url: 'about:blank' } })
  const pending = waitForPagePresentation(id)
  await getClock().tickAsync(16)
  await pending
})
