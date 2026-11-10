/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLayoutEffect, useRef } from 'react'
import { usePageStore } from './page-store'
import type { PagePresentation } from '@shared/page-protocol'

export type PageSlotRegistration = { element: HTMLElement; mode: PagePresentation }
const slots = new Map<string, Map<HTMLElement, PageSlotRegistration>>()
const listeners = new Set<() => void>()
export const pageSlots = {
  get: (id: string, mode: PagePresentation) => {
    const candidates = [...(slots.get(id)?.values() ?? [])].filter(
      (slot) => slot.mode === mode && slot.element.isConnected,
    )
    const visibleArea = (slot: PageSlotRegistration) => {
      const rect = slot.element.getBoundingClientRect()
      return (
        Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left)) *
        Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top))
      )
    }
    // A repeated local-app result may reserve several inline cards. Keep a single
    // renderer in the most visible slot, preferring the newest when tied.
    return candidates.reverse().sort((a, b) => visibleArea(b) - visibleArea(a))[0]
  },
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  notify: () => listeners.forEach((listener) => listener()),
}
/** A slot reserves layout space; the running renderer stays in its permanent host. */
export const PageSlot = ({
  sessionId,
  mode,
  height,
}: {
  sessionId: string
  mode: PagePresentation
  height?: number
}) => {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) {
      return
    }
    const entries = slots.get(sessionId) ?? new Map<HTMLElement, PageSlotRegistration>()
    entries.set(element, { element, mode })
    slots.set(sessionId, entries)
    pageSlots.notify()
    return () => {
      entries.delete(element)
      if (!entries.size) {
        slots.delete(sessionId)
      }
      pageSlots.notify()
      // Allow a presentation transfer or Strict Mode remount to register its
      // replacement slot before disposing a document no longer in a transcript.
      queueMicrotask(() => {
        const session = usePageStore.getState().sessions.find((item) => item.id === sessionId)
        if (session?.presentation === 'inline' && !slots.get(sessionId)?.size) {
          usePageStore.getState().close(sessionId)
        }
      })
    }
  }, [sessionId, mode])
  return (
    <div
      ref={ref}
      data-page-slot={sessionId}
      className="relative min-h-0 w-full flex-1"
      style={height === undefined ? { height: '100%' } : { height }}
    />
  )
}
