/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { LucideIcon } from 'lucide-react'
import type { SearchEntityType } from './types'
import {
  Bot,
  CheckSquare,
  Cpu,
  FolderOpen,
  MessageSquare,
  MessageSquareText,
  Plug,
  Smartphone,
  Zap,
} from 'lucide-react'

/**
 * Static description of one indexable entity. The data layer builds the FTS
 * index from `tableName`/`titleField`/`bodyFields`, and the UI derives display
 * and navigation from `icon`/`route`.
 */
export type SearchEntityConfig = {
  type: SearchEntityType
  /** PowerSync view/table name (see `src/db/tables.ts`). */
  tableName: string
  /** Field rendered as the result title, or null when the entity has none. */
  titleField: string | null
  /** Fields concatenated into the searchable body / snippet. */
  bodyFields: string[]
  /** Field holding the parent id used to build the route, or null. */
  parentIdField: string | null
  icon: LucideIcon
  /** Builds the router path for a hit from its id and optional parent id. */
  route: (args: { id: string; parentId: string | null }) => string
}

/**
 * The frozen contract shared by every search stream. Entries are populated
 * exactly per the THU-766 spec; excluded tables (settings, model_profiles,
 * modes, prompts, triggers, *_secrets) are intentionally absent.
 */
export const searchEntities: SearchEntityConfig[] = [
  {
    type: 'chat',
    tableName: 'chat_threads',
    titleField: 'title',
    bodyFields: [],
    parentIdField: null,
    icon: MessageSquare,
    route: ({ id }) => `/chats/${id}`,
  },
  {
    type: 'message',
    tableName: 'chat_messages',
    titleField: null,
    bodyFields: ['content'],
    parentIdField: 'chat_thread_id',
    icon: MessageSquareText,
    route: ({ parentId }) => `/chats/${parentId}`,
  },
  {
    type: 'model',
    tableName: 'models',
    titleField: 'name',
    bodyFields: ['description', 'vendor', 'model'],
    parentIdField: null,
    icon: Cpu,
    route: () => '/settings/models',
  },
  {
    type: 'skill',
    tableName: 'skills',
    titleField: 'label',
    bodyFields: ['description', 'instruction', 'name'],
    parentIdField: null,
    icon: Zap,
    route: () => '/settings/skills',
  },
  {
    type: 'agent',
    tableName: 'agents',
    titleField: 'name',
    bodyFields: ['description'],
    parentIdField: null,
    icon: Bot,
    route: () => '/settings/agents',
  },
  {
    type: 'mcp',
    tableName: 'mcp_servers',
    titleField: 'name',
    bodyFields: ['url', 'command'],
    parentIdField: null,
    icon: Plug,
    route: () => '/settings/connections',
  },
  {
    type: 'device',
    tableName: 'devices',
    titleField: 'name',
    bodyFields: [],
    parentIdField: null,
    icon: Smartphone,
    route: () => '/settings/devices',
  },
  {
    type: 'project',
    tableName: 'projects',
    titleField: 'name',
    bodyFields: ['description', 'instructions'],
    parentIdField: null,
    icon: FolderOpen,
    route: ({ id }) => `/projects/${id}`,
  },
  {
    type: 'task',
    tableName: 'tasks',
    titleField: 'item',
    bodyFields: [],
    parentIdField: null,
    icon: CheckSquare,
    route: () => '/tasks',
  },
]

/**
 * Monotonic schema version for the search index. Bump whenever the registry or
 * FTS schema changes so consumers rebuild the index instead of reading a stale
 * one. (Started at 1; bumped to 2 for the soft-delete guard + the snake_case
 * message-parent fix, which changed the triggers and backfill; 3 adds projects.)
 */
export const searchIndexVersion = 3
