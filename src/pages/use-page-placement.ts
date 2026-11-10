/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLayoutEffect, useState } from 'react'
import { pageSlots } from './page-slot'
import type { PageSession } from './page-store'

type Placement = { x: number; y: number; width: number; height: number; clip: string; visible: boolean }
const hidden: Placement = { x: 0, y: 0, width: 1, height: 1, clip: 'inset(0)', visible: false }
/** Mirror the chosen DOM slot's geometry and scroll clipping without moving the renderer. */
export const usePagePlacement = (session: PageSession, active: boolean) => {
  const [placement, setPlacement] = useState(hidden)
  useLayoutEffect(() => {
    let frame = 0
    const measure = () => {
      frame = 0
      const slot = pageSlots.get(session.id, session.presentation)?.element
      if (!active || !slot || !slot.isConnected || !slot.getClientRects().length) {
        setPlacement((previous) => (previous.visible ? { ...previous, visible: false } : previous))
        return
      }
      const rect = slot.getBoundingClientRect()
      let left = Math.max(0, rect.left),
        top = Math.max(0, rect.top)
      let right = Math.min(innerWidth, rect.right),
        bottom = Math.min(innerHeight, rect.bottom)
      for (let parent = slot.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent)
        if (style.visibility === 'hidden' || parent.inert || parent.getAttribute('aria-hidden') === 'true') {
          right = left
          break
        }
        const bounds = parent.getBoundingClientRect()
        if (/(hidden|auto|scroll|clip)/.test(style.overflowX)) {
          left = Math.max(left, bounds.left)
          right = Math.min(right, bounds.right)
        }
        if (/(hidden|auto|scroll|clip)/.test(style.overflowY)) {
          top = Math.max(top, bounds.top)
          bottom = Math.min(bottom, bounds.bottom)
        }
      }
      // Native children cannot be covered by DOM dialogs. Hide a page when a modal crosses its viewport.
      const covered = [
        ...document.querySelectorAll<HTMLElement>(
          '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [data-slot="popover-content"][data-state="open"]',
        ),
      ].some((dialog) => {
        if (dialog.contains(slot)) {
          return false
        }
        const r = dialog.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && r.left < right && r.right > left && r.top < bottom && r.bottom > top
      })
      const next = {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        clip: `inset(${Math.max(0, top - rect.top)}px ${Math.max(0, rect.right - right)}px ${Math.max(0, rect.bottom - bottom)}px ${Math.max(0, left - rect.left)}px)`,
        visible: !covered && right > left && bottom > top,
      }
      setPlacement((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next))
    }
    const schedule = () => {
      if (!frame) {
        frame = requestAnimationFrame(measure)
      }
    }
    const observer = new ResizeObserver(schedule)
    const mutation = new MutationObserver(schedule)
    const bind = () => {
      observer.disconnect()
      const slot = pageSlots.get(session.id, session.presentation)?.element
      if (slot) {
        observer.observe(slot)
        if (slot.parentElement) {
          observer.observe(slot.parentElement)
        }
      }
      // Slot/presentation changes must land before paint so the previous page
      // rectangle never intercepts a click while React moves the chrome.
      cancelAnimationFrame(frame)
      measure()
    }
    const unsubscribe = pageSlots.subscribe(bind)
    mutation.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'data-state', 'inert', 'aria-hidden'],
    })
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('resize', schedule)
    bind()
    return () => {
      unsubscribe()
      observer.disconnect()
      mutation.disconnect()
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('resize', schedule)
    }
  }, [session.id, session.presentation, active])
  return placement
}
