/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Collapses a text control's selection at the end without affecting
 * non-text controls.
 */
export const collapseTextSelectionToEnd = (element: Element | null) => {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    return
  }
  if (element.selectionStart === null) {
    return
  }
  const end = element.value.length
  element.setSelectionRange(end, end)
}

/**
 * Defers selection collapse until a dialog's default autofocus has run.
 * Prevented autofocus events are left untouched for explicit behaviors such
 * as rename fields that intentionally select all text.
 */
const collapseAutoFocusedTextSelection = (event: Event) => {
  if (event.defaultPrevented) {
    return
  }
  const content = event.currentTarget
  requestAnimationFrame(() => {
    if (content instanceof HTMLElement && content.contains(document.activeElement)) {
      collapseTextSelectionToEnd(document.activeElement)
    }
  })
}

/**
 * Wraps a modal content's `onOpenAutoFocus` so the default autofocus lands
 * with a collapsed selection. The caller's own handler always runs first.
 */
export const withCollapsedAutoFocusSelection = (onOpenAutoFocus?: (event: Event) => void) => (event: Event) => {
  onOpenAutoFocus?.(event)
  collapseAutoFocusedTextSelection(event)
}
