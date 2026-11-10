/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isTauriDesktop } from '@/lib/platform'
import { t } from '@lingui/core/macro'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { type RefObject, useEffect, useEffectEvent, useRef, useState } from 'react'
import type { PanelImperativeHandle } from 'react-resizable-panels'

type ResizeInput = { owner: string; gesture: number; phase: 'start' | 'move' | 'end'; screenX: number }
type Options = {
  enabled: boolean
  panelRef: RefObject<PanelImperativeHandle | null>
  beginResize: () => void
  endResize: () => Promise<void> | undefined
}

/** Keep the native grip above page surfaces while React continues owning panel layout. */
export const useBrowserResizeGrip = ({ enabled, panelRef, beginResize, endResize }: Options) => {
  const separatorRef = useRef<HTMLDivElement>(null)
  const [nativeReady, setNativeReady] = useState(false)
  const begin = useEffectEvent(beginResize)
  const end = useEffectEvent(endResize)
  const nativeEnabled = enabled && isTauriDesktop()

  useEffect(() => {
    const separator = separatorRef.current
    if (!nativeEnabled || !separator) {
      return
    }
    const grip = separator.querySelector<HTMLElement>('[data-slot="resizable-handle-grip"]')!
    const owner = crypto.randomUUID()
    let active = true
    let frame = 0
    let lastPresentation = ''
    let queue = Promise.resolve()
    let unlisten: (() => void) | undefined
    let drag: { gesture: number; screenX: number; width: number } | undefined
    const reportError = (error: unknown) => console.error('Could not update browser resize grip', error)
    const finish = () => {
      if (!drag) {
        return
      }
      drag = undefined
      delete document.documentElement.dataset.browserResizing
      void end()?.catch(reportError)
    }
    const update = async () => {
      if (!active) {
        return
      }
      const [origin, scale] = await Promise.all([getCurrentWebview().position(), getCurrentWindow().scaleFactor()])
      if (!active) {
        return
      }
      const bounds = separator.getBoundingClientRect()
      const style = getComputedStyle(grip)
      const presentation = {
        x: Math.round(bounds.right - 12 + origin.x / scale),
        y: Math.round(window.innerHeight / 2 - 20 + origin.y / scale),
        colors: {
          background: style.backgroundColor,
          foreground: style.color,
          border: style.borderColor,
          hover: style.backgroundColor,
        },
        label: t`Resize browser`,
      }
      const serialized = JSON.stringify(presentation)
      if (serialized === lastPresentation) {
        return
      }
      await invoke('browser_resize_update', { owner, presentation })
      lastPresentation = serialized
      if (active) {
        setNativeReady(true)
      }
    }
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        queue = queue.then(update).catch(reportError)
      })
    }
    const connect = async () => {
      const stop = await listen<ResizeInput>('browser-resize-drag', ({ payload }) => {
        if (!active || payload.owner !== owner) {
          return
        }
        const panel = panelRef.current
        if (!panel) {
          return
        }
        if (payload.phase === 'start') {
          drag = { gesture: payload.gesture, screenX: payload.screenX, width: panel.getSize().inPixels }
          begin()
          document.documentElement.dataset.browserResizing = 'true'
          return
        }
        if (!drag || payload.gesture !== drag.gesture) {
          return
        }
        panel.resize(`${Math.max(1, drag.width - (payload.screenX - drag.screenX))}px`)
        schedule()
        if (payload.phase === 'end') {
          finish()
        }
      })
      if (!active) {
        return stop()
      }
      unlisten = stop
      schedule()
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(separator)
    for (const panel of separator.parentElement?.children ?? []) {
      observer.observe(panel)
    }
    const themeObserver = new MutationObserver(schedule)
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
    window.addEventListener('resize', schedule)
    void connect().catch(reportError)
    return () => {
      active = false
      cancelAnimationFrame(frame)
      observer.disconnect()
      themeObserver.disconnect()
      window.removeEventListener('resize', schedule)
      unlisten?.()
      finish()
      setNativeReady(false)
      queue = queue.then(() => invoke<void>('browser_resize_update', { owner, presentation: null })).catch(reportError)
    }
  }, [nativeEnabled, panelRef])

  return { separatorRef, nativeReady: nativeEnabled && nativeReady }
}
