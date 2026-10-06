/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Embedded surfaces: the chrome and gestures shared by artifacts and Mini Apps.
 *
 * Both are an opaque cross-origin document in a frame, so both need the same
 * things — a status/error strip over the frame, a highlight-to-ask popover, an
 * element picker, and a correlated request registry for talking to the guest.
 * One copy, used by two features.
 *
 * This barrel is the public surface, per the multi-file-feature rule in
 * `AGENTS.md`. Everything not re-exported here is internal, and the list is
 * deliberately shorter than the sum of the modules:
 *
 *  - `picked-passage` and `placeSelectionPopover` are implementation details of
 *    the picker and the popover.
 *  - `SurfaceRect` and `SurfacePickedElement` are only referenced through the
 *    types that contain them.
 *
 * Consumers import from `@/components/embedded`. Reaching past this file is how
 * an internal helper quietly becomes API.
 */

export { createPendingRequests, elementAtTimeoutMs, type PendingRequests } from './pending-requests'
export { ElementPickOverlay } from './element-pick-overlay'
export { SelectionPopover } from './selection-popover'
export { useElementPicking, type ElementPickMode } from './use-element-picking'
export { EmbeddedErrorStrip, EmbeddedSurfaceStatus } from './surface-status'
export type { SurfaceHighlightedElement, SurfaceTextSelection } from './types'
