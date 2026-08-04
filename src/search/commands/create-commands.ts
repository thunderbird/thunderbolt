/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Bot, Cpu, Zap, type LucideIcon } from 'lucide-react'
import { buildActionNav } from '../actions/entity-actions'
import type { SearchEntityType } from '../types'
import type { PaletteCommand } from './types'

/**
 * Declarative source for the palette's "Create X" commands. This is a hardcoded
 * allow-list: an entity gets a create command only if it appears here AND
 * {@link buildActionNav} supports a `create` intent for it — adding create
 * support to the manifest alone won't surface a command; add it here too. The icon
 * mirrors the entity's navigation glyph so the create row reads as the same
 * surface as its "go to" nav command.
 */
const createCommandSpecs: { entityType: SearchEntityType; id: string; title: string; icon: LucideIcon }[] = [
  { entityType: 'model', id: 'create-model', title: 'Create Model', icon: Cpu },
  { entityType: 'skill', id: 'create-skill', title: 'Create Skill', icon: Zap },
  { entityType: 'agent', id: 'create-agent', title: 'Create Agent', icon: Bot },
]

/**
 * Build the "Create X" commands, one per entity that supports a `create`
 * intent. Each command carries the `to` + `state` from {@link buildActionNav}
 * so selecting it navigates to the owning settings page and hands it a
 * one-shot create intent via `location.state`. Entities whose config doesn't
 * support `create` are skipped.
 */
export const buildCreateCommands = (): PaletteCommand[] =>
  createCommandSpecs.flatMap(({ entityType, id, title, icon }) => {
    const nav = buildActionNav(entityType, { type: 'create' })
    if (!nav) {
      return []
    }
    return [{ id, title, icon, section: 'create', keywords: ['new', 'add'], ...nav }]
  })
