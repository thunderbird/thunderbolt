/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Shared vocabulary for embedded surfaces — Mini Apps and artifacts.
 *
 * These live outside both features on purpose. The two surfaces have
 * deliberately different sandboxes (a Mini App is a real origin with its own
 * backend; an artifact is model-written HTML with an opaque origin and no
 * network), but a user shouldn't be able to tell the gestures apart. Anything
 * above the frame belongs here so it can't drift.
 */

/** A rectangle in the guest frame's own viewport coordinates. */
export type SurfaceRect = { x: number; y: number; width: number; height: number }

/** Highlighted text plus where it sits in the guest frame's own viewport. */
export type SurfaceTextSelection = { text: string; rect?: SurfaceRect }

/** One element the guest resolved, ready to become a composer chip. */
export type SurfaceSelectionItem = {
  id: string
  label: string
  text: string
  /** Structured payload, forwarded to the model uninterpreted. Mini Apps only. */
  data?: unknown
}

/**
 * The element under the pointer, with the geometry needed to outline it.
 *
 * `rect` is in the guest's own viewport coordinates, so the host offsets it
 * against the frame's position rather than trying to compute it — only the
 * guest can measure its own layout and scroll.
 */
export type SurfaceHighlightedElement = SurfaceSelectionItem & { rect: SurfaceRect }
