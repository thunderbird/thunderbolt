/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { PhysicalPosition } from '@tauri-apps/api/dpi'
import type { EventCallback } from '@tauri-apps/api/event'
import type { DragDropEvent } from '@tauri-apps/api/webview'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { useNativeFileDrop } from './use-native-file-drop'

/** A stand-in for Tauri's drag-drop subscription that lets the test fire events. */
const fakeWebview = () => {
  const handlers = new Set<EventCallback<DragDropEvent>>()
  const stop = mock(() => {})
  const listen = mock(async (handler: EventCallback<DragDropEvent>) => {
    handlers.add(handler)
    return () => {
      stop()
      handlers.delete(handler)
    }
  })
  const emit = (payload: DragDropEvent) => {
    act(() => {
      for (const handler of handlers) {
        handler({ event: 'tauri://drag-drop', id: 1, payload })
      }
    })
  }
  return { listen, stop, emit }
}

const zone = document.createElement('div')
const inside = new PhysicalPosition(10, 10)
const outside = new PhysicalPosition(500, 500)

describe('useNativeFileDrop', () => {
  beforeEach(() => {
    document.body.append(zone)
    spyOn(document, 'elementFromPoint').mockImplementation((x) => (x === inside.x ? zone : document.body))
  })

  afterEach(() => {
    zone.remove()
    mock.restore()
  })

  const setup = (enabled = true) => {
    const webview = fakeWebview()
    const onHoverChange = mock((_hovering: boolean) => {})
    const onDrop = mock((_paths: string[]) => {})
    const hook = renderHook(
      ({ on }) =>
        useNativeFileDrop({ zoneRef: { current: zone }, enabled: on, onHoverChange, onDrop, listen: webview.listen }),
      { initialProps: { on: enabled } },
    )
    return { ...webview, onHoverChange, onDrop, hook }
  }

  it('shows the drop hint only while the drag is over the zone', () => {
    const { emit, onHoverChange } = setup()

    emit({ type: 'enter', paths: ['/home/ana/deck.pptx'], position: outside })
    emit({ type: 'over', position: inside })
    emit({ type: 'leave' })

    expect(onHoverChange.mock.calls).toEqual([[false], [true], [false]])
  })

  it('hands over the dropped paths when the drop lands on the zone', () => {
    const { emit, onDrop, onHoverChange } = setup()

    emit({ type: 'drop', paths: ['/home/ana/deck.pptx'], position: inside })

    expect(onDrop).toHaveBeenCalledWith(['/home/ana/deck.pptx'])
    expect(onHoverChange).toHaveBeenLastCalledWith(false)
  })

  it('ignores a drop outside the zone', () => {
    const { emit, onDrop } = setup()

    emit({ type: 'drop', paths: ['/home/ana/deck.pptx'], position: outside })

    expect(onDrop).not.toHaveBeenCalled()
  })

  it('does not listen while disabled', () => {
    const { listen } = setup(false)

    expect(listen).not.toHaveBeenCalled()
  })

  it('stops listening when disabled or unmounted', async () => {
    const { stop, hook, emit, onDrop } = setup()

    hook.rerender({ on: false })
    await act(async () => {})
    emit({ type: 'drop', paths: ['/home/ana/deck.pptx'], position: inside })

    expect(stop).toHaveBeenCalledTimes(1)
    expect(onDrop).not.toHaveBeenCalled()

    hook.rerender({ on: true })
    hook.unmount()
    await act(async () => {})
    expect(stop).toHaveBeenCalledTimes(2)
  })
})
