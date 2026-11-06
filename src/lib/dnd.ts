/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Modifier } from '@dnd-kit/core'

/** Keeps sortable rows on their vertical track while preserving DnD scale data. */
export const lockToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 })

/** Stable modifier list for vertical sortable lists — avoids a new array per render. */
export const verticalAxisModifiers = [lockToVerticalAxis]
