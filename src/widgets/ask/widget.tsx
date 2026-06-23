/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useCurrentChatSession } from '@/chats/chat-store'
import { useDatabase } from '@/contexts'
import { getMessage, updateMessageCache } from '@/dal/chat-messages'
import { useQuery, useQueryClient } from '@tanstack/react-query'

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
  const queryClient = useQueryClient()
  const { chatInstance } = useCurrentChatSession()
  const storageKey = askStorageKey({ prompt, mode, options })
  const queryKey = ['askState', messageId, storageKey]

  const { data: saved, isPending } = useQuery({
    queryKey,
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
    // Persist first so the response is recorded (and restores on reload)
    // regardless of what follows.
    await updateMessageCache(db, messageId, storageKey, entry)
    // Keep the (infinitely-cached) query in sync so an unmount/remount in the
    // same session restores the answer instead of re-reading the stale `null`.
    queryClient.setQueryData(queryKey, entry)

    // `choice` (an action pick) and `free` (a typed answer) are conversational
    // responses, so dispatch the answer as a normal user turn for the model to
    // act on / reply to. Graded `single`/`multiple` reveal the answer
    // client-side and are NOT auto-sent — doing so would goad
    // single-prompt-at-a-time backends into endlessly asking the next question.
    // (Persisted entries still reach the model via formatAskResponsesNote.)
    if (mode === 'choice' || mode === 'free') {
      const answer = (text ?? chosen[0] ?? '').trim()
      if (answer) {
        // Best-effort: the answer is already persisted, so a failed send (e.g.
        // no model selected) loses nothing — surface it without breaking the UI.
        await chatInstance.sendMessage({ text: answer }).catch((error) => {
          console.error('Ask widget failed to dispatch answer turn', error)
        })
      }
    }
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
