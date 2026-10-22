/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { NavigateFunction } from 'react-router'
import { v7 as uuidv7 } from 'uuid'
import { usePendingQuotesStore } from '@/chats/pending-quotes-store'
import { setPendingPrompt } from '@/chats/pending-prompt-store'
import { artifactPath, type Artifact } from './artifact'

/** Open an artifact with a conversation, queuing the request before its composer mounts. */
export const openArtifactChat = (
  artifact: Artifact,
  navigate: NavigateFunction,
  request: { passages?: string[]; prompt?: string } = {},
): void => {
  const chatId = artifact.chatThreadId ?? uuidv7()
  for (const text of request.passages ?? []) {
    usePendingQuotesStore.getState().addQuote(chatId, { text })
  }
  if (request.prompt) {
    setPendingPrompt(chatId, request.prompt)
  }
  if (artifact.chatThreadId) {
    void navigate(`${artifactPath(artifact.id)}?chat=${encodeURIComponent(chatId)}`)
    return
  }
  void navigate(artifactPath(artifact.id), { state: { artifactDraftChatId: chatId } })
}

/** Only a host-created draft ID is accepted from the optional navigation state. */
export const artifactDraftChatId = (state: unknown): string | null => {
  if (!state || typeof state !== 'object' || !('artifactDraftChatId' in state)) {
    return null
  }
  return typeof state.artifactDraftChatId === 'string' && state.artifactDraftChatId.length > 0
    ? state.artifactDraftChatId
    : null
}

/** Existing remote chat provenance retains its raw configured ID. */
export const artifactChatOrigin = (artifact: Artifact): string =>
  artifact.reference.kind === 'remote' ? artifact.reference.appId : artifact.id
