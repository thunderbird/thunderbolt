/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Chats that were started from a Mini App. */

import { eq } from 'drizzle-orm'

import { chatThreadsTable } from '@/db/tables'
import { useChatsWithLastActivity, type ChatWithLastActivity } from './chats-with-last-activity'

/** A chat started from a Mini App, with when it was last active. */
export type MiniAppChat = ChatWithLastActivity

/**
 * Live chats started from one Mini App, newest activity first.
 *
 * The query itself is shared with `useProjectChats` — see
 * {@link useChatsWithLastActivity}. What stays here is the column, and the
 * lifecycle note that made this a separate module in the first place: a project
 * is a row this app owns and cleans up after, while a Mini App is deployment
 * config that can vanish between releases, so a project orphans its chats on
 * delete and an app leaves theirs pointing at an id that no longer resolves.
 * That divergence lives in the mutations, not in this read.
 */
export const useMiniAppChats = (appId: string): MiniAppChat[] =>
  useChatsWithLastActivity(['miniAppChats', appId], eq(chatThreadsTable.miniAppId, appId))
