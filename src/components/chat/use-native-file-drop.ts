/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { EventCallback, UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebview, type DragDropEvent } from '@tauri-apps/api/webview'
import { useEffect, useEffectEvent, type RefObject } from 'react'

type ListenToDragDrop = (handler: EventCallback<DragDropEvent>) => Promise<UnlistenFn>

type NativeFileDropOptions = {
  /** The drop target: a drag counts only while the pointer is over it. */
  zoneRef: RefObject<HTMLElement | null>
  enabled: boolean
  onHoverChange: (hovering: boolean) => void
  onDrop: (paths: string[]) => void
  /** Tauri's drag-drop subscription; tests pass a fake. */
  listen?: ListenToDragDrop
}

const listenToWebview: ListenToDragDrop = (handler) => getCurrentWebview().onDragDropEvent(handler)

/** Whether a native drag position falls inside `zone`. GTK reports it in logical pixels, which are CSS pixels. */
const isOverZone = (zone: HTMLElement | null, { x, y }: { x: number; y: number }): boolean =>
  zone?.contains(document.elementFromPoint(x, y)) ?? false

/**
 * Hands over the paths of files dragged in from the OS where the page cannot
 * see them (Linux, see `readsFilesByPath`). There `tauri.linux.conf.json` turns
 * on the native drag-drop handler, whose events carry the dragged paths.
 */
export const useNativeFileDrop = ({
  zoneRef,
  enabled,
  onHoverChange,
  onDrop,
  listen = listenToWebview,
}: NativeFileDropOptions) => {
  const handleDragDrop = useEffectEvent((event: DragDropEvent) => {
    if (event.type === 'leave') {
      onHoverChange(false)
      return
    }
    const over = isOverZone(zoneRef.current, event.position)
    if (event.type !== 'drop') {
      onHoverChange(over)
      return
    }
    onHoverChange(false)
    if (over) {
      onDrop(event.paths)
    }
  })

  useEffect(() => {
    if (!enabled) {
      return
    }
    const unlisten = listen((event) => handleDragDrop(event.payload))
    return () => {
      void unlisten.then((stop) => stop())
    }
  }, [enabled, listen])
}
