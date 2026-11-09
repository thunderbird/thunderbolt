/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useDatabase, useHttpClient } from '@/contexts'
import { isValidEmailFormat } from '@/lib/utils'
import {
  ChatNotSyncedError,
  lookUpRecipients,
  RecipientUnavailableError,
  ShareChangedElsewhereError,
  shareChat,
  type ShareableRecipient,
  ShareTooLargeError,
} from '@/services/shares'
import { type SentShare, useStopSharing } from '@/shared-chats/use-shared-chats'
import { maxShareEmailLength, maxShareRecipients, type ShareRecipientCheck } from '@shared/chat-shares'
import { useEffect, useEffectEvent, useReducer } from 'react'

/** One email in the input, from typed to looked up. */
export type ShareRecipientTag =
  | { email: string; status: 'checking' | 'unavailable' | 'invalid' }
  | { email: string; status: 'ok'; recipient: ShareableRecipient }

export type ShareFailure = 'too-large' | 'not-synced' | 'changed-elsewhere' | 'stop-failed' | 'failed'

/**
 * The chat's existing share, when the dialog opened on a chat already shared.
 * Saving replaces only the `version` the dialog read.
 */
export type ExistingShare = { shareId: string; version: number; emails: string[] }

export type ShareChatState = {
  draft: string
  tags: ShareRecipientTag[]
  phase: 'editing' | 'sharing' | 'shared' | 'confirming-stop' | 'stopping' | 'load-failed'
  failure: ShareFailure | null
  existing: ExistingShare | null
}

type ShareChatAction =
  | { type: 'DRAFT_CHANGED'; draft: string }
  | { type: 'EMAILS_ADDED'; emails: string[] }
  | { type: 'LOOKED_UP'; results: ShareRecipientCheck[] }
  | { type: 'LOOKUP_FAILED'; emails: string[] }
  | { type: 'EXISTING_LOOKUP_FAILED' }
  | { type: 'EMAIL_REMOVED'; email: string }
  | { type: 'SHARE_STARTED' }
  | { type: 'SHARE_SUCCEEDED' }
  | { type: 'SHARE_FAILED'; failure: ShareFailure; unavailableEmail?: string }
  | { type: 'STOP_REQUESTED' }
  | { type: 'STOP_CANCELLED' }
  | { type: 'STOP_STARTED' }
  | { type: 'STOP_FAILED' }

/** The dialog's state when it opens: empty for a new share, prefilled with who it is shared with otherwise. */
export const initialShareChatState = (existing: ExistingShare | null = null): ShareChatState => ({
  draft: '',
  tags: (existing?.emails ?? []).map((email) => ({ email, status: 'checking' })),
  phase: 'editing',
  failure: null,
  existing,
})

/** Split pasted or typed text into candidate emails: commas, semicolons and whitespace separate them. */
export const splitEmails = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[\s,;]+/)
    .filter((email) => email.length > 0)

/** Whether `email` looks like an address the directory could know, before asking it. */
export const isPlausibleEmail = (email: string): boolean =>
  email.length <= maxShareEmailLength && isValidEmailFormat(email)

/** Emails from `candidates` that are new to `tags`, deduplicated, within the recipient cap. */
export const emailsToAdd = (tags: ShareRecipientTag[], candidates: string[]): string[] => {
  const present = new Set(tags.map((tag) => tag.email))
  const fresh = [...new Set(candidates)].filter((email) => !present.has(email))
  return fresh.slice(0, Math.max(0, maxShareRecipients - tags.length))
}

/** Whether a tag stops the share: the address is malformed, or cannot receive shared chats. */
export const isBlockingTag = (tag: ShareRecipientTag): boolean =>
  tag.status === 'unavailable' || tag.status === 'invalid'

/** The share dialog's state transitions: one case per thing that happened. */
export const shareChatReducer = (state: ShareChatState, action: ShareChatAction): ShareChatState => {
  switch (action.type) {
    case 'DRAFT_CHANGED':
      return { ...state, draft: action.draft }
    case 'EMAILS_ADDED':
      return {
        ...state,
        draft: '',
        failure: null,
        tags: [
          ...state.tags,
          // Filtered again against the current tags: two commits in one render
          // would otherwise both pass the check made when they were typed.
          ...emailsToAdd(state.tags, action.emails).map(
            (email): ShareRecipientTag =>
              isPlausibleEmail(email) ? { email, status: 'checking' } : { email, status: 'invalid' },
          ),
        ],
      }
    case 'LOOKED_UP':
      return {
        ...state,
        tags: state.tags.map((tag) => {
          const result = action.results.find((candidate) => candidate.email === tag.email)
          if (!result || tag.status !== 'checking') {
            return tag
          }
          return result.status === 'ok'
            ? { email: tag.email, status: 'ok', recipient: result }
            : { email: tag.email, status: 'unavailable' }
        }),
      }
    case 'LOOKUP_FAILED':
      return {
        ...state,
        failure: 'failed',
        tags: state.tags.filter((tag) => !(tag.status === 'checking' && action.emails.includes(tag.email))),
      }
    case 'EXISTING_LOOKUP_FAILED':
      // Dropping the share's people here would make saving revoke them, so
      // the dialog cannot edit this share until it can check them again.
      return { ...state, phase: 'load-failed' }
    case 'EMAIL_REMOVED':
      return { ...state, failure: null, tags: state.tags.filter((tag) => tag.email !== action.email) }
    case 'SHARE_STARTED':
      return { ...state, phase: 'sharing', failure: null }
    case 'SHARE_SUCCEEDED':
      return { ...state, phase: 'shared' }
    case 'SHARE_FAILED':
      return {
        ...state,
        phase: 'editing',
        failure: action.failure,
        tags: action.unavailableEmail
          ? state.tags.map((tag) =>
              tag.email === action.unavailableEmail ? { email: tag.email, status: 'unavailable' } : tag,
            )
          : state.tags,
      }
    case 'STOP_REQUESTED':
      return { ...state, phase: 'confirming-stop', failure: null }
    case 'STOP_CANCELLED':
      return { ...state, phase: 'editing' }
    case 'STOP_STARTED':
      return { ...state, phase: 'stopping' }
    case 'STOP_FAILED':
      return { ...state, phase: 'editing', failure: 'stop-failed' }
  }
}

/** Whether every tag is a looked-up, shareable recipient — and there is at least one. */
export const canShare = (state: ShareChatState): boolean =>
  state.phase === 'editing' && state.tags.length > 0 && state.tags.every((tag) => tag.status === 'ok')

/** Whether the tags are exactly the people the chat is already shared with — saving then only refreshes it. */
export const isSameRecipients = (state: ShareChatState): boolean => {
  if (!state.existing) {
    return false
  }
  const current = new Set(state.tags.map((tag) => tag.email))
  return current.size === state.existing.emails.length && state.existing.emails.every((email) => current.has(email))
}

/** What a share failure maps to in the dialog. */
export const toShareFailure = (error: unknown): { failure: ShareFailure; unavailableEmail?: string } => {
  if (error instanceof ShareTooLargeError) {
    return { failure: 'too-large' }
  }
  if (error instanceof ChatNotSyncedError) {
    return { failure: 'not-synced' }
  }
  if (error instanceof ShareChangedElsewhereError) {
    return { failure: 'changed-elsewhere' }
  }
  if (error instanceof RecipientUnavailableError) {
    return { failure: 'failed', unavailableEmail: error.email }
  }
  console.error('Sharing a chat failed', error)
  return { failure: 'failed' }
}

/** The recipients a sent share lists, as the dialog's starting point. */
export const toExistingShare = (share: SentShare | undefined): ExistingShare | null =>
  share
    ? {
        shareId: share.id,
        version: share.version,
        emails: share.recipients.map((recipient) => recipient.email.toLowerCase()),
      }
    : null

/**
 * The share dialog's state: the email tags, their lookups, and the share
 * itself. Opened on a chat that is already shared, it starts from that share's
 * people, looks them up again — one may no longer be able to receive shares —
 * and saving replaces the share in place.
 */
export const useShareChatState = (chatThreadId: string, existingShare: SentShare | undefined) => {
  const httpClient = useHttpClient()
  const db = useDatabase()
  const stopSharing = useStopSharing()
  const [state, dispatch] = useReducer(shareChatReducer, toExistingShare(existingShare), initialShareChatState)

  const lookUp = async (emails: string[], onFailure: ShareChatAction) => {
    const plausible = emails.filter(isPlausibleEmail)
    if (plausible.length === 0) {
      return
    }
    try {
      dispatch({ type: 'LOOKED_UP', results: await lookUpRecipients(httpClient, plausible) })
    } catch (error) {
      console.error('Looking up share recipients failed', error)
      dispatch(onFailure)
    }
  }

  // Legitimate useEffect: an async lookup on mount, of the people an existing
  // share already has, so one who can no longer receive shares shows as such.
  const lookUpExisting = useEffectEvent(() => {
    if (state.existing) {
      void lookUp(state.existing.emails, { type: 'EXISTING_LOOKUP_FAILED' })
    }
  })
  useEffect(() => {
    lookUpExisting()
  }, [])

  const addEmails = async (text: string) => {
    const emails = emailsToAdd(state.tags, splitEmails(text))
    dispatch({ type: 'EMAILS_ADDED', emails })
    await lookUp(emails, { type: 'LOOKUP_FAILED', emails })
  }

  const share = async () => {
    const recipients = state.tags.flatMap((tag) => (tag.status === 'ok' ? [tag.recipient] : []))
    dispatch({ type: 'SHARE_STARTED' })
    try {
      await shareChat(httpClient, db, chatThreadId, recipients, state.existing ?? undefined)
    } catch (error) {
      dispatch({ type: 'SHARE_FAILED', ...toShareFailure(error) })
      return
    }
    dispatch({ type: 'SHARE_SUCCEEDED' })
  }

  const stop = (onStopped: () => void) => {
    if (!state.existing) {
      return
    }
    dispatch({ type: 'STOP_STARTED' })
    stopSharing.mutate(state.existing.shareId, {
      onSuccess: onStopped,
      onError: (error) => {
        console.error('Stopping a share failed', error)
        dispatch({ type: 'STOP_FAILED' })
      },
    })
  }

  return {
    state,
    canShare: canShare(state),
    isSameRecipients: isSameRecipients(state),
    setDraft: (draft: string) => dispatch({ type: 'DRAFT_CHANGED', draft }),
    addEmails,
    removeEmail: (email: string) => dispatch({ type: 'EMAIL_REMOVED', email }),
    share,
    requestStop: () => dispatch({ type: 'STOP_REQUESTED' }),
    cancelStop: () => dispatch({ type: 'STOP_CANCELLED' }),
    stop,
  }
}
