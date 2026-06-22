/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useDatabase } from '@/contexts'
import { getMessage, updateMessageCache } from '@/dal/chat-messages'
import { useQuery } from '@tanstack/react-query'

import { Ask, type AskSubmission } from './display'
import { type AskCacheEntry, type AskData, type AskOption, askStorageKey } from './lib'

type AskWidgetProps = Omit<AskData, 'options'> & {
  /** Absent for `free` (text-response) prompts; defaults to an empty list. */
  options?: AskOption[]
  messageId: string
}

/**
 * Connects the presentational {@link Ask} to the message cache: restores a
 * prior response on mount and persists the user's response on submit. Persisted
 * entries are later surfaced to the model (see `formatAskResponsesNote`).
 */
export const AskWidget = ({ prompt, mode, options = [], explanation, messageId }: AskWidgetProps) => {
  const db = useDatabase()
  const storageKey = askStorageKey(prompt)

  const { data: saved, isPending } = useQuery({
    queryKey: ['askState', messageId, storageKey],
    queryFn: async () => {
      const message = await getMessage(db, messageId)
      const cache = message?.cache as Record<string, unknown> | null | undefined
      return (cache?.[storageKey] as AskCacheEntry | undefined) ?? null
    },
    staleTime: Infinity,
    gcTime: Infinity,
  })

  const handleSubmit = async ({ selectedIds, matched, text }: AskSubmission) => {
    // `free` mode carries a typed answer; option modes map ids back to their texts.
    const chosen = text !== undefined ? [text] : selectedIds.map((id) => options.find((o) => o.id === id)?.text ?? id)
    const entry: AskCacheEntry = { prompt, mode, selectedIds, chosen, matched, text }
    // Persist the response so the widget restores answered on reload. We
    // intentionally do NOT dispatch a follow-up turn: the widget reveals any
    // designated answer client-side, so a prompt stands on its own, and the
    // persisted entry is surfaced to the model on later turns via
    // formatAskResponsesNote. Sending a turn per response would also goad
    // single-prompt-at-a-time backends into endlessly asking the next one.
    await updateMessageCache(db, messageId, storageKey, entry)
  }

  // Wait for the cached response before seeding the (lazy) initial state, so a
  // restored prompt doesn't briefly flash as unanswered.
  if (isPending) {
    return <div className="my-4 h-40 w-full animate-pulse rounded-2xl border border-border bg-card" />
  }

  return (
    <Ask
      prompt={prompt}
      mode={mode}
      options={options}
      explanation={explanation}
      initialSelectedIds={saved?.selectedIds}
      initialText={saved?.text}
      initialSubmitted={saved !== null}
      onSubmit={handleSubmit}
    />
  )
}
