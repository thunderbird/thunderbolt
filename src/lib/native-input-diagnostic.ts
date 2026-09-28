/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { BaseDirectory } from '@tauri-apps/api/path'
import { mkdir, writeTextFile } from '@tauri-apps/plugin-fs'

type ProbeDetail = Record<string, string | number | boolean>

/** Temporary native-only probe: records geometry and event metadata, never field contents. */
export const startNativeInputDiagnostic = () => {
  const state = { sequence: 0, generation: 0, input: null as HTMLInputElement | null, geometry: '' }
  const ready = mkdir('native-input-probe', { baseDir: BaseDirectory.AppData, recursive: true })

  const record = async (kind: string, detail: ProbeDetail = {}) => {
    if (state.sequence >= 100) {
      return
    }
    const input = document.querySelector<HTMLInputElement>('input[type="email"]')
    const rect = input?.getBoundingClientRect()
    const entry = {
      kind,
      sequence: state.sequence++,
      time: performance.now(),
      generation: state.generation,
      present: Boolean(input),
      focused: document.activeElement === input,
      activeTag: document.activeElement?.tagName ?? '',
      valueLength: input?.value.length ?? -1,
      bodyPointerEvents: getComputedStyle(document.body).pointerEvents,
      x: rect?.x ?? -1,
      y: rect?.y ?? -1,
      width: rect?.width ?? -1,
      height: rect?.height ?? -1,
      viewportHeight: window.visualViewport?.height ?? -1,
      ...detail,
    }
    try {
      await ready
      await writeTextFile('native-input-probe/native-input-probe.jsonl', `${JSON.stringify(entry)}\n`, {
        baseDir: BaseDirectory.AppData,
        append: true,
      })
    } catch {
      console.warn('[DEBUG-native-input] diagnostic write failed')
    }
  }

  const observer = new MutationObserver(() => {
    const input = document.querySelector<HTMLInputElement>('input[type="email"]')
    const rect = input?.getBoundingClientRect()
    const geometry = rect ? `${rect.x},${rect.y},${rect.width},${rect.height}` : ''
    if (input !== state.input) {
      state.generation += 1
      state.input = input
      void record(input ? 'field-mounted' : 'field-removed')
    } else if (geometry !== state.geometry) {
      void record('field-moved')
    }
    state.geometry = geometry
  })
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style'],
  })
  for (const kind of ['pointerdown', 'pointerup', 'focusin', 'focusout', 'beforeinput', 'input']) {
    document.addEventListener(
      kind,
      (event) => {
        void record(kind, {
          targetTag: event.target instanceof Element ? event.target.tagName : '',
          trusted: event.isTrusted,
          clientX: event instanceof PointerEvent ? event.clientX : -1,
          clientY: event instanceof PointerEvent ? event.clientY : -1,
        })
      },
      true,
    )
  }
  window.visualViewport?.addEventListener('resize', () => void record('viewport-resize'))
  void record('probe-started')
}
