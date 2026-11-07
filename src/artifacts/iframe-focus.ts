/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

type FrameFocusListener = (frame: HTMLIFrameElement | null) => void
const listeners = new Set<FrameFocusListener>()
let focusedFrame: HTMLIFrameElement | null = null
let animationFrame: number | null = null

/** Observe focus while it is inside a child browsing context, which does not bubble DOM focus events. */
const observeFocus = () => {
  animationFrame = null
  const frame = document.activeElement instanceof HTMLIFrameElement ? document.activeElement : null
  if (focusedFrame !== frame) {
    focusedFrame = frame
    for (const listener of listeners) {
      listener(frame)
    }
  }
  // A→B iframe transitions emit no second parent blur. Observe only while a
  // frame owns focus, with one animation loop shared by every mounted surface.
  if (frame && listeners.size > 0) {
    animationFrame = requestAnimationFrame(observeFocus)
  }
}

const checkFocus = () => {
  if (animationFrame !== null) {
    cancelAnimationFrame(animationFrame)
  }
  observeFocus()
}

/** Subscribe to actual iframe focus, including frame-to-frame moves; the observer sleeps outside frames. */
export const subscribeToIframeFocus = (listener: FrameFocusListener): (() => void) => {
  listeners.add(listener)
  if (listeners.size === 1) {
    window.addEventListener('blur', checkFocus)
    window.addEventListener('focus', checkFocus)
    checkFocus()
  } else {
    listener(focusedFrame)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size !== 0) {
      return
    }
    window.removeEventListener('blur', checkFocus)
    window.removeEventListener('focus', checkFocus)
    if (animationFrame !== null) {
      cancelAnimationFrame(animationFrame)
    }
    animationFrame = null
    focusedFrame = null
  }
}
