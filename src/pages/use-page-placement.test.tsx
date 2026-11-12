/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, expect, it, spyOn } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import { pageSlots } from './page-slot'
import { usePageStore } from './page-store'
import { usePagePlacement } from './use-page-placement'

const disposals: (() => void)[] = []
afterEach(() => {
  cleanup()
  disposals.splice(0).forEach((dispose) => dispose())
  usePageStore.setState({ sessions: [], activeId: null })
})

const mount = (native: boolean) => {
  const id = usePageStore.getState().ensure({
    id: crypto.randomUUID(),
    title: 'Page',
    source: native ? { kind: 'url', url: 'https://example.com' } : { kind: 'html', html: '<p>Keep visible</p>' },
  })
  const parent = document.createElement('div')
  const slot = document.createElement('div')
  parent.append(slot)
  document.body.append(parent)
  const rect = new DOMRect(10, 20, 200, 150)
  const rectSpy = spyOn(slot, 'getBoundingClientRect').mockReturnValue(rect)
  const rectsSpy = spyOn(slot, 'getClientRects').mockReturnValue([rect] as unknown as DOMRectList)
  const getSlot = spyOn(pageSlots, 'get').mockReturnValue({ element: slot, mode: 'sidebar' })
  disposals.push(() => {
    parent.remove()
    rectSpy.mockRestore()
    rectsSpy.mockRestore()
    getSlot.mockRestore()
  })
  const session = usePageStore.getState().sessions.find((item) => item.id === id)!
  const hook = renderHook(({ active }) => usePagePlacement(session, active), { initialProps: { active: true } })
  return { ...hook, parent }
}

it.each([false, true])('keeps a modal-blocked HTML page painted but hides native children (native: %s)', (native) => {
  const { result, parent } = mount(native)
  expect(result.current).toMatchObject({ visible: true, interactive: true })
  parent.setAttribute('aria-hidden', 'true')
  act(() => pageSlots.notify())
  expect(result.current).toMatchObject({ visible: !native, interactive: false })
  parent.removeAttribute('aria-hidden')
  parent.inert = true
  act(() => pageSlots.notify())
  expect(result.current).toMatchObject({ visible: !native, interactive: false })
  parent.inert = false
  act(() => pageSlots.notify())
  expect(result.current).toMatchObject({ visible: true, interactive: true })
})

it.each([false, true])('uses native-only occlusion for an overlapping tab menu (native: %s)', (native) => {
  const { result } = mount(native)
  const menu = document.createElement('div')
  menu.setAttribute('role', 'menu')
  menu.dataset.state = 'open'
  document.body.append(menu)
  const rect = spyOn(menu, 'getBoundingClientRect').mockReturnValue(new DOMRect(50, 30, 100, 100))
  disposals.push(() => {
    menu.remove()
    rect.mockRestore()
  })
  act(() => pageSlots.notify())
  expect(result.current).toMatchObject({ visible: !native, interactive: false })
  rect.mockReturnValue(new DOMRect(500, 500, 100, 100))
  act(() => pageSlots.notify())
  expect(result.current).toMatchObject({ visible: true, interactive: true })
})

it('still hides inactive and CSS-hidden HTML pages', () => {
  const { result, parent, rerender } = mount(false)
  rerender({ active: false })
  expect(result.current).toMatchObject({ visible: false, interactive: false })
  rerender({ active: true })
  expect(result.current).toMatchObject({ visible: true, interactive: true })
  parent.style.visibility = 'hidden'
  act(() => pageSlots.notify())
  expect(result.current).toMatchObject({ visible: false, interactive: false })
})
