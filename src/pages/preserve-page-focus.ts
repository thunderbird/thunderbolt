/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Restore chat focus after synthetic input, unless the user has moved focus elsewhere in the meantime. */
export const preservePageFocus = async <T>(sessionId: string, action: () => Promise<T>): Promise<T> => {
  const focused = document.activeElement
  const input = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement ? focused : null
  const selection = input ? ([input.selectionStart, input.selectionEnd] as const) : null
  try {
    return await action()
  } finally {
    const active = document.activeElement
    const pageHasFocus =
      active instanceof HTMLIFrameElement &&
      active.closest<HTMLElement>('[data-page-host]')?.dataset.pageHost === sessionId
    if (pageHasFocus && focused instanceof HTMLElement && focused.isConnected) {
      focused.focus({ preventScroll: true })
      if (input && selection && selection[0] !== null && selection[1] !== null) {
        input.setSelectionRange(selection[0], selection[1])
      }
    }
  }
}
