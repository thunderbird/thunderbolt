/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { searchEntities } from '../registry'
import type { SearchEntityType } from '../types'

/** Human-facing group headings, one per entity type (plural, sentence case). */
export const entityLabels: Record<SearchEntityType, MessageDescriptor> = {
  chat: msg`Chats`,
  message: msg`Messages`,
  model: msg`Models`,
  skill: msg`Skills`,
  agent: msg`Agents`,
  mcp: msg`Connections`,
  device: msg`Devices`,
  task: msg`Tasks`,
  project: msg`Projects`,
}

/** Lucide icon for each entity type, sourced from the shared registry. */
export const entityIcons = Object.fromEntries(searchEntities.map((entity) => [entity.type, entity.icon])) as Record<
  SearchEntityType,
  (typeof searchEntities)[number]['icon']
>
