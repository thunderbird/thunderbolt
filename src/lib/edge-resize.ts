/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Edge hit-testing for the frameless window on Linux.
 *
 * An undecorated GTK window currently exposes no resize band — not inside the window,
 * not on its last pixel, not outside it (tauri-apps/tauri#16266). The compositor is
 * willing: `startResizeDragging` reaches `gtk_window_begin_resize_drag` and resizes
 * correctly. Only the hit-test that would start one is missing, so the app does it.
 *
 * Temporary by construction: remove this file and its hook when the upstream fix
 * lands.
 */
import { getCurrentWindow } from '@tauri-apps/api/window'
import { getPlatform, isTauri } from '@/lib/platform'

/**
 * Hit zone (CSS px) inside each window edge that starts a native resize drag.
 *
 * Not an arbitrary number: it mirrors the resize border a GTK window manager draws
 * for a decorated window (fly-wm, Mutter and Xfwm all sit in the 5-8 px range across
 * their default themes), so a frameless Volt window feels the same as every other
 * window on the desktop. There is no API that reports the WM's own value to a
 * webview, so matching the convention is the closest honest anchor available.
 */
export const edgeResizeZone = 6

/**
 * The same band for a coarse pointer. A finger cannot be placed to 6 px, and the
 * platform guidance everyone follows puts the smallest comfortable touch target far
 * above that — this is the narrowest band that is still catchable by touch without
 * swallowing presses meant for the content underneath.
 */
export const edgeResizeZoneCoarse = 12

/**
 * Pick the band from how precisely the user can actually point, which is the property
 * the number is really about. Falls back to the fine value where `matchMedia` is
 * unavailable, since every desktop this ships to has a mouse.
 */
export const resolveEdgeResizeZone = (): number =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
    ? edgeResizeZoneCoarse
    : edgeResizeZone

/**
 * Window resize direction, mirroring Tauri's internal `ResizeDirection`.
 * Tauri declares the type but does not export it, so we restate the union
 * here to keep this module free of the Tauri runtime (and unit-testable).
 */
export type ResizeDirection =
  | 'East'
  | 'North'
  | 'NorthEast'
  | 'NorthWest'
  | 'South'
  | 'SouthEast'
  | 'SouthWest'
  | 'West'

/**
 * Map a pointer position inside the window to a native resize direction,
 * or null when it is not within `zone` px of any edge. Corners win over
 * single edges. Bands are exclusive: west is `x < zone`, east is
 * `x >= width - zone` (same for the vertical axis), so the two half-bands
 * never overlap and a press at `zone` itself is treated as interior.
 */
export const edgeDirectionAt = (
  x: number,
  y: number,
  width: number,
  height: number,
  zone = edgeResizeZone,
): ResizeDirection | null => {
  const west = x < zone
  const east = x >= width - zone
  const north = y < zone
  const south = y >= height - zone

  if (north && west) {
    return 'NorthWest'
  }
  if (north && east) {
    return 'NorthEast'
  }
  if (south && west) {
    return 'SouthWest'
  }
  if (south && east) {
    return 'SouthEast'
  }
  if (west) {
    return 'West'
  }
  if (east) {
    return 'East'
  }
  if (north) {
    return 'North'
  }
  if (south) {
    return 'South'
  }
  return null
}

const skippedSelector = [
  'button',
  '[role="button"]',
  'a',
  'input',
  'textarea',
  'select',
  '[role="menuitem"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="radio"]',
].join(', ')

/**
 * True when the pressed target is (or sits inside) an interactive control,
 * so a resize gesture never hijacks a click on a real control that happens
 * to sit flush against the window edge (e.g. the custom title-bar buttons).
 */
export const isInteractiveTarget = (target: EventTarget | null | undefined): boolean => {
  if (!(target instanceof Element)) {
    return false
  }
  return target.closest(skippedSelector) !== null
}

/** Direction for a DOM pointer event, using the current viewport as the window bounds. */
export const resizeDirectionFromPointerEvent = (event: PointerEvent): ResizeDirection | null =>
  edgeDirectionAt(event.clientX, event.clientY, window.innerWidth, window.innerHeight, resolveEdgeResizeZone())

/**
 * CSS cursor for each direction. Without this the edges are invisible affordances —
 * the window resizes, but only for someone who already knows it does.
 */
const cursorByDirection: Record<ResizeDirection, string> = {
  East: 'ew-resize',
  West: 'ew-resize',
  North: 'ns-resize',
  South: 'ns-resize',
  NorthWest: 'nwse-resize',
  SouthEast: 'nwse-resize',
  NorthEast: 'nesw-resize',
  SouthWest: 'nesw-resize',
}

/** The resize cursor for a position, or null when it is not on an edge. */
export const edgeCursorAt = (
  x: number,
  y: number,
  width: number,
  height: number,
  zone = resolveEdgeResizeZone(),
): string | null => {
  const direction = edgeDirectionAt(x, y, width, height, zone)
  return direction ? cursorByDirection[direction] : null
}

/**
 * True on the Linux Tauri desktop build, where an undecorated window has no native
 * resize band at all — see https://github.com/tauri-apps/tauri/issues/16266. Delete
 * this module once that is fixed; nothing else depends on it.
 */
export const canLinuxEdgeResize = (): boolean => isTauri() && getPlatform() === 'linux'

/**
 * Document-level pointerdown handler: when the press lands within the edge
 * band (and not on an interactive control), hand the drag to the tauri
 * native resize path (`startResizeDragging`).
 */
export const startLinuxEdgeResize = (event: PointerEvent): void => {
  if (!canLinuxEdgeResize()) {
    return
  }
  const direction = resizeDirectionFromPointerEvent(event)
  if (!direction || isInteractiveTarget(event.target)) {
    return
  }
  event.preventDefault()
  void getCurrentWindow().startResizeDragging(direction)
}
