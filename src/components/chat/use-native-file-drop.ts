/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { EventCallback, UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebview, type DragDropEvent } from '@tauri-apps/api/webview'
import { useEffect, useEffectEvent, useRef, type RefObject } from 'react'
import { httpLinks } from '@/lib/native-files'

type ListenToDragDrop = (handler: EventCallback<DragDropEvent>) => Promise<UnlistenFn>

type NativeFileDropOptions = {
  /** The drop target: a drag counts only while the pointer is over it. */
  zoneRef: RefObject<HTMLElement | null>
  enabled: boolean
  /** Called only for a drag that carries files, so a dragged link shows no drop hint. */
  onHoverChange: (hovering: boolean) => void
  onDrop: (paths: string[], links: string[]) => void
  /** Tauri's drag-drop subscription; tests pass a fake. */
  listen?: ListenToDragDrop
}

const listenToWebview: ListenToDragDrop = (handler) => getCurrentWebview().onDragDropEvent(handler)

/** Whether a native drag position falls inside `zone`. GTK reports it in logical pixels, which are CSS pixels. */
const isOverZone = (zone: HTMLElement | null, { x, y }: { x: number; y: number }): boolean =>
  zone?.contains(document.elementFromPoint(x, y)) ?? false

/** Tauri strips `file://` from a local file's URI and passes any other URI, such as a browser link, through. */
const isFilePath = (path: string): boolean => path.startsWith('/')

/**
 * Hands over the paths of files dragged in from the OS where the page cannot
 * see them (Linux, see `readsFilesByPath`). There `tauri.linux.conf.json` turns
 * on the native drag-drop handler, whose events carry the dragged paths. That
 * handler also takes every dragged link away from the page, so the links come
 * out here too.
 */
export const useNativeFileDrop = ({
  zoneRef,
  enabled,
  onHoverChange,
  onDrop,
  listen = listenToWebview,
}: NativeFileDropOptions) => {
  const carriesFiles = useRef(false)

  const handleDragDrop = useEffectEvent((event: DragDropEvent) => {
    if (event.type === 'leave') {
      onHoverChange(false)
      return
    }
    if (event.type === 'enter') {
      carriesFiles.current = event.paths.some(isFilePath)
    }
    const over = isOverZone(zoneRef.current, event.position)
    if (event.type !== 'drop') {
      onHoverChange(over && carriesFiles.current)
      return
    }
    onHoverChange(false)
    if (over) {
      // shortcut: Tauri also decodes the escapes in a link, so an escaped `&`, `=` or `/` comes back bare. Read the
      // raw `text/uri-list` in `platform_utils.rs` if such links need to arrive unchanged.
      onDrop(event.paths.filter(isFilePath), httpLinks(event.paths).map(encodeURI))
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
