/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { SearchEntityType } from '../types'
import type { EntityActionIntent } from './types'

type EntityActionConfig = {
  /** Settings route the intent is delivered to. */
  page: string
  /** `location.state` key the target page reads via `useEntityActionIntent`. */
  stateKey: string
  /** Which affordances this entity exposes (drives edit-on-click + create commands). */
  supports: {
    create?: boolean
    edit?: boolean
    remove?: boolean
  }
}

/**
 * Registry of entities that support inline palette actions. Entries listed
 * here open their edit panel when a result row is clicked and/or contribute a
 * "Create X" command. v1 ships Models + Skills (THU-768); Agents add
 * create + edit. Removal is never triggered from the palette — it stays behind
 * each detail panel's ⋯ menu, which is where ownership/flavor gates it; the
 * `remove` intent is retained only as a generic capability of the contract.
 */
export const entityActions: Partial<Record<SearchEntityType, EntityActionConfig>> = {
  model: {
    page: '/settings/models',
    stateKey: 'modelsAction',
    supports: { create: true, edit: true, remove: true },
  },
  skill: {
    page: '/settings/skills',
    stateKey: 'skillsAction',
    supports: { create: true, edit: true, remove: true },
  },
  agent: {
    page: '/settings/agents',
    stateKey: 'agentsAction',
    supports: { create: true, edit: true },
  },
}

/**
 * Look up the action config for an entity kind, or `undefined` when the
 * entity has no inline actions in v1.
 */
export const getEntityActions = (entityType: SearchEntityType): EntityActionConfig | undefined =>
  entityActions[entityType]

/**
 * Build the router navigation ({@link to} + `location.state`) that delivers
 * an action intent to the owning settings page, or `null` when the entity
 * doesn't support the requested action. The intent is JSON-encoded because
 * the shared `useConsumeNavState` consumer only fires for string state
 * values — `useEntityActionIntent` decodes it back into an intent object.
 */
export const buildActionNav = (
  entityType: SearchEntityType,
  intent: EntityActionIntent,
): { to: string; state: Record<string, unknown> } | null => {
  const cfg = getEntityActions(entityType)
  if (!cfg || !cfg.supports[intent.type]) {
    return null
  }
  return { to: cfg.page, state: { [cfg.stateKey]: JSON.stringify(intent) } }
}
