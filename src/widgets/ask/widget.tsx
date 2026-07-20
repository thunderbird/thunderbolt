/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useCurrentChatSession } from '@/chats/chat-store'
import { useDatabase } from '@/contexts'
import { getMessage, updateMessageCache } from '@/dal/chat-messages'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { Ask, type AskSubmission } from './display'
import { type AskCacheEntry, type AskData, type AskMode, type AskOption, askStorageKey, turnTextForAnswer } from './lib'

type AskWidgetProps = Omit<AskData, 'mode' | 'options'> & {
  /** `free` appears only in messages persisted before the mode was removed. */
  mode: AskMode | 'free'
  /** Absent on legacy `free` widgets; defaults to an empty list. */
  options?: AskOption[]
  messageId: string
}

/**
 * Read-only rendering of a legacy `free` (typed-answer) ask. The mode was
 * removed from authoring, but historical messages still carry the markup —
 * show the question and, when the user answered before the removal, their
 * recorded answer.
 */
const LegacyFreeAsk = ({ prompt, savedText }: { prompt: string; savedText: string | null }) => (
  <div className="my-4 w-full rounded-2xl border border-border bg-card px-4 py-3">
    <p className="text-[length:var(--font-size-body)]">{prompt}</p>
    {savedText !== null && (
      <p className="mt-2 text-[length:var(--font-size-sm)] text-muted-foreground">Answered: “{savedText}”</p>
    )}
  </div>
)

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

  // Wait for the cached response before seeding the (lazy) initial state, so a
  // restored prompt doesn't briefly flash as unanswered.
  if (isPending) {
    return <div className="my-4 h-40 w-full animate-pulse rounded-2xl border border-border bg-card" />
  }

  if (mode === 'free') {
    return <LegacyFreeAsk prompt={prompt} savedText={saved?.text ?? saved?.chosen[0] ?? null} />
  }

  const handleSubmit = async ({ selectedIds, matched }: AskSubmission) => {
    const chosen = selectedIds.map((id) => options.find((o) => o.id === id)?.text ?? id)
    const entry: AskCacheEntry = { prompt, mode, selectedIds, chosen, matched }
    try {
      // Persist first so the response is recorded (and restores on reload)
      // regardless of what follows.
      await updateMessageCache(db, messageId, storageKey, entry)
    } catch (error) {
      // The Ask is invoked fire-and-forget from a click handler, so a
      // rejection here would otherwise vanish unhandled while the UI already
      // shows "submitted" — log it; the in-session query cache below still
      // keeps the answer visible until reload.
      console.error('Ask widget failed to persist the answer', error)
    }
    // Keep the (infinitely-cached) query in sync so an unmount/remount in the
    // same session restores the answer instead of re-reading the stale `null`.
    queryClient.setQueryData(queryKey, entry)

    // For `choice`, dispatch the pick as a normal user turn so the model acts
    // on it; graded modes return null (see `turnTextForAnswer`).
    const turnText = turnTextForAnswer(mode, chosen)
    if (turnText) {
      try {
        await chatInstance.sendMessage({ text: turnText })
      } catch (error) {
        // Best-effort: the answer is already persisted, so a failed send (e.g.
        // no model selected) loses nothing — surface it without breaking the UI.
        console.error('Ask widget failed to dispatch answer turn', error)
      }
    }
  }

  return (
    <Ask
      prompt={prompt}
      mode={mode}
      options={options}
      explanation={explanation}
      initialSelectedIds={saved?.selectedIds}
      initialSubmitted={saved !== null}
      onSubmit={handleSubmit}
    />
  )
}
