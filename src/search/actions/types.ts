/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** The inline affordances the palette can trigger on an entity (THU-768). */
export type EntityActionType = 'create' | 'edit' | 'remove'

/**
 * A one-shot instruction the palette hands to a settings page via router
 * state: which affordance to fire and, for `edit`/`remove`, on which row.
 */
export type EntityActionIntent = {
  type: EntityActionType
  id?: string
}
