/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useDatabase } from '@/contexts'
import { getMessage, updateMessageCache } from '@/dal/chat-messages'
import { useQuery } from '@tanstack/react-query'

import { Quiz, type QuizSubmission } from './display'
import { type QuizCacheEntry, type QuizData, quizStorageKey } from './lib'

type QuizWidgetProps = QuizData & {
  messageId: string
}

/**
 * Connects the presentational {@link Quiz} to the message cache: restores a
 * prior answer on mount and persists the user's choice on submit. Persisted
 * entries are later surfaced to the model (see `formatQuizResultsNote`).
 */
export const QuizWidget = ({ prompt, mode, options, explanation, messageId }: QuizWidgetProps) => {
  const db = useDatabase()
  const storageKey = quizStorageKey(prompt)

  const { data: saved, isPending } = useQuery({
    queryKey: ['quizState', messageId, storageKey],
    queryFn: async () => {
      const message = await getMessage(db, messageId)
      const cache = message?.cache as Record<string, unknown> | null | undefined
      return (cache?.[storageKey] as QuizCacheEntry | undefined) ?? null
    },
    staleTime: Infinity,
    gcTime: Infinity,
  })

  const handleSubmit = async ({ selectedIds, correct }: QuizSubmission) => {
    const chosen = selectedIds.map((id) => options.find((o) => o.id === id)?.text ?? id)
    const entry: QuizCacheEntry = { prompt, mode, selectedIds, chosen, correct }
    await updateMessageCache(db, messageId, storageKey, entry)
  }

  // Wait for the cached answer before seeding the (lazy) initial state, so a
  // restored quiz doesn't briefly flash as unanswered.
  if (isPending) {
    return <div className="my-4 h-40 w-full animate-pulse rounded-2xl border border-border bg-card" />
  }

  return (
    <Quiz
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
