/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { BaseDirectory } from '@tauri-apps/api/path'
import { mkdir, writeTextFile } from '@tauri-apps/plugin-fs'

type ProbeDetail = Record<string, string | number | boolean>

/** Temporary native-only probe: records passive event and focus metadata, never field contents. */
export const startNativeInputDiagnostic = () => {
  const state = { sequence: 0, generation: 0, input: null as HTMLInputElement | null }
  const ready = mkdir('native-input-probe', { baseDir: BaseDirectory.AppData, recursive: true })

  const record = async (kind: string, detail: ProbeDetail = {}) => {
    if (state.sequence >= 100) {
      return
    }
    const input = document.querySelector<HTMLInputElement>('input[type="email"]')
    const entry = {
      kind,
      sequence: state.sequence++,
      time: performance.now(),
      generation: state.generation,
      present: Boolean(input),
      focused: document.activeElement === input,
      activeTag: document.activeElement?.tagName ?? '',
      disabled: input?.disabled ?? false,
      valueLength: input?.value.length ?? -1,
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
    if (input !== state.input) {
      state.generation += 1
      state.input = input
      void record(input ? 'field-mounted' : 'field-removed')
    }
  })
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  })
  for (const kind of [
    'pointerdown',
    'pointerup',
    'pointercancel',
    'click',
    'focusin',
    'focusout',
    'beforeinput',
    'input',
  ]) {
    document.addEventListener(
      kind,
      (event) => {
        void record(kind, {
          targetTag: event.target instanceof Element ? event.target.tagName : '',
          trusted: event.isTrusted,
          eventTime: event.timeStamp,
          clientX: event instanceof MouseEvent ? event.clientX : -1,
          clientY: event instanceof MouseEvent ? event.clientY : -1,
        })
      },
      { capture: true, passive: true },
    )
  }
  window.visualViewport?.addEventListener('resize', () => void record('viewport-resize'))
  void record('probe-started')
}
