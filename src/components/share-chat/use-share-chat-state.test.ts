/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, spyOn } from 'bun:test'
import {
  ChatNotSyncedError,
  RecipientUnavailableError,
  ShareChangedElsewhereError,
  ShareTooLargeError,
} from '@/services/shares'
import type { ShareRecipientCheck } from '@shared/chat-shares'
import {
  canShare,
  emailsToAdd,
  initialShareChatState,
  isPlausibleEmail,
  isSameRecipients,
  shareChatReducer,
  splitEmails,
  toExistingShare,
  toShareFailure,
  type ShareChatState,
} from './use-share-chat-state'

const okRecipient = (email: string): ShareRecipientCheck => ({
  email,
  status: 'ok',
  userId: `id-${email}`,
  inboxVersion: 1,
  ecdhPublicKey: 'ecdh',
  mlkemPublicKey: 'mlkem',
})

const withEmails = (...emails: string[]): ShareChatState =>
  shareChatReducer(initialShareChatState(), { type: 'EMAILS_ADDED', emails })

const lookedUp = (state: ShareChatState, ...emails: string[]): ShareChatState =>
  shareChatReducer(state, { type: 'LOOKED_UP', results: emails.map(okRecipient) })

describe('splitEmails', () => {
  it('splits on commas, semicolons and whitespace, lowercasing', () => {
    expect(splitEmails(' Ada@Example.com, bob@example.com;carol@example.com\ndan@example.com ')).toEqual([
      'ada@example.com',
      'bob@example.com',
      'carol@example.com',
      'dan@example.com',
    ])
  })
})

describe('isPlausibleEmail', () => {
  it.each([
    ['ada@example.com', true],
    ['ada@example', false],
    ['ada.example.com', false],
    ['@example.com', false],
    [`${'a'.repeat(250)}@example.com`, false],
  ])('%s → %s', (email, expected) => {
    expect(isPlausibleEmail(email)).toBe(expected)
  })
})

describe('emailsToAdd', () => {
  it('drops emails already present and duplicates within the batch', () => {
    const state = withEmails('ada@example.com')
    expect(emailsToAdd(state.tags, ['ada@example.com', 'bob@example.com', 'bob@example.com'])).toEqual([
      'bob@example.com',
    ])
  })

  it('stops at the recipient cap', () => {
    const state = withEmails(...Array.from({ length: 19 }, (_, i) => `p${i}@example.com`))
    expect(emailsToAdd(state.tags, ['a@example.com', 'b@example.com'])).toEqual(['a@example.com'])
  })
})

describe('initialShareChatState', () => {
  it('starts empty for a chat not shared yet', () => {
    expect(initialShareChatState()).toMatchObject({ tags: [], existing: null, phase: 'editing' })
  })

  it('starts from the people an existing share has, each to be looked up again', () => {
    const existing = toExistingShare({
      id: 'share-1',
      chatThreadId: 'thread-1',
      updatedAt: '2026-11-07T10:00:00.000Z',
      version: 3,
      recipients: [{ userId: 'u1', name: 'Ada', email: 'Ada@Example.com' }],
    })
    const state = initialShareChatState(existing)
    expect(state.existing).toEqual({
      shareId: 'share-1',
      version: 3,
      emails: ['ada@example.com'],
    })
    expect(state.tags).toEqual([{ email: 'ada@example.com', status: 'checking' }])
  })
})

describe('shareChatReducer', () => {
  it('adds plausible emails as checking and others as invalid, clearing the draft', () => {
    const state = shareChatReducer(
      { ...initialShareChatState(), draft: 'typing' },
      { type: 'EMAILS_ADDED', emails: ['ada@example.com', 'nope'] },
    )
    expect(state.draft).toBe('')
    expect(state.tags).toEqual([
      { email: 'ada@example.com', status: 'checking' },
      { email: 'nope', status: 'invalid' },
    ])
  })

  it('drops an email added twice before a render, rather than tagging it twice', () => {
    const once = withEmails('ada@example.com')
    const twice = shareChatReducer(once, { type: 'EMAILS_ADDED', emails: ['ada@example.com'] })
    expect(twice.tags).toHaveLength(1)
  })

  it('resolves lookups into shareable or unavailable tags', () => {
    const state = shareChatReducer(withEmails('ada@example.com', 'bob@example.com'), {
      type: 'LOOKED_UP',
      results: [okRecipient('ada@example.com'), { email: 'bob@example.com', status: 'unavailable' }],
    })
    expect(state.tags.map((tag) => tag.status)).toEqual(['ok', 'unavailable'])
  })

  it('ignores a late lookup for a tag that is no longer being checked', () => {
    const unavailable = shareChatReducer(withEmails('ada@example.com'), {
      type: 'LOOKED_UP',
      results: [{ email: 'ada@example.com', status: 'unavailable' }],
    })
    expect(lookedUp(unavailable, 'ada@example.com').tags).toEqual([{ email: 'ada@example.com', status: 'unavailable' }])
  })

  it('drops tags whose lookup failed and reports it', () => {
    const state = shareChatReducer(withEmails('ada@example.com'), {
      type: 'LOOKUP_FAILED',
      emails: ['ada@example.com'],
    })
    expect(state.tags).toEqual([])
    expect(state.failure).toBe('failed')
  })

  it('keeps an existing share’s people when looking them up fails, and stops the edit', () => {
    const existing = initialShareChatState({ shareId: 's', version: 1, emails: ['ada@example.com'] })
    const failed = shareChatReducer(existing, { type: 'EXISTING_LOOKUP_FAILED' })
    expect(failed.phase).toBe('load-failed')
    expect(failed.tags).toEqual(existing.tags)
    expect(canShare(failed)).toBe(false)
  })

  it('removing an email clears a failure', () => {
    const failed = shareChatReducer(withEmails('ada@example.com'), { type: 'LOOKUP_FAILED', emails: [] })
    const removed = shareChatReducer(failed, { type: 'EMAIL_REMOVED', email: 'ada@example.com' })
    expect(removed).toMatchObject({ tags: [], failure: null })
  })

  it('marks a recipient unavailable when the share finds them gone', () => {
    const looked = lookedUp(withEmails('ada@example.com'), 'ada@example.com')
    const failed = shareChatReducer(shareChatReducer(looked, { type: 'SHARE_STARTED' }), {
      type: 'SHARE_FAILED',
      failure: 'failed',
      unavailableEmail: 'ada@example.com',
    })
    expect(failed.phase).toBe('editing')
    expect(failed.tags).toEqual([{ email: 'ada@example.com', status: 'unavailable' }])
  })

  it('walks the stop-sharing confirmation, back to editing on cancel or failure', () => {
    const requested = shareChatReducer(initialShareChatState(), { type: 'STOP_REQUESTED' })
    expect(requested.phase).toBe('confirming-stop')
    expect(shareChatReducer(requested, { type: 'STOP_CANCELLED' }).phase).toBe('editing')
    const stopping = shareChatReducer(requested, { type: 'STOP_STARTED' })
    expect(stopping.phase).toBe('stopping')
    expect(shareChatReducer(stopping, { type: 'STOP_FAILED' })).toMatchObject({
      phase: 'editing',
      failure: 'stop-failed',
    })
  })
})

describe('canShare', () => {
  it('needs at least one tag, every tag shareable, and an idle form', () => {
    expect(canShare(initialShareChatState())).toBe(false)
    const checking = withEmails('ada@example.com')
    expect(canShare(checking)).toBe(false)
    const ready = lookedUp(checking, 'ada@example.com')
    expect(canShare(ready)).toBe(true)
    expect(canShare(shareChatReducer(ready, { type: 'SHARE_STARTED' }))).toBe(false)
    const mixed = shareChatReducer(ready, { type: 'EMAILS_ADDED', emails: ['bad'] })
    expect(canShare(mixed)).toBe(false)
  })

  it('blocks saving an existing share while one of its people can no longer receive shares', () => {
    const existing = initialShareChatState({
      shareId: 's',
      version: 1,
      emails: ['ada@example.com', 'bob@example.com'],
    })
    const state = shareChatReducer(existing, {
      type: 'LOOKED_UP',
      results: [okRecipient('ada@example.com'), { email: 'bob@example.com', status: 'unavailable' }],
    })
    expect(canShare(state)).toBe(false)
    expect(canShare(shareChatReducer(state, { type: 'EMAIL_REMOVED', email: 'bob@example.com' }))).toBe(true)
  })
})

describe('isSameRecipients', () => {
  const existing = initialShareChatState({
    shareId: 's',
    version: 1,
    emails: ['ada@example.com', 'bob@example.com'],
  })

  it('is true while the tags are exactly the share’s people, in any order', () => {
    expect(isSameRecipients(existing)).toBe(true)
  })

  it('is false once someone is added or removed, and for a new share', () => {
    expect(isSameRecipients(shareChatReducer(existing, { type: 'EMAIL_REMOVED', email: 'bob@example.com' }))).toBe(
      false,
    )
    expect(isSameRecipients(shareChatReducer(existing, { type: 'EMAILS_ADDED', emails: ['carol@example.com'] }))).toBe(
      false,
    )
    expect(isSameRecipients(initialShareChatState())).toBe(false)
  })
})

describe('toShareFailure', () => {
  it.each<[Error, ReturnType<typeof toShareFailure>]>([
    [new ShareTooLargeError(), { failure: 'too-large' }],
    [new ChatNotSyncedError(), { failure: 'not-synced' }],
    [new ShareChangedElsewhereError(), { failure: 'changed-elsewhere' }],
    [new RecipientUnavailableError('ada@example.com'), { failure: 'failed', unavailableEmail: 'ada@example.com' }],
  ])('maps %s', (error, expected) => {
    expect(toShareFailure(error)).toEqual(expected)
  })

  it('reports anything else as a generic failure', () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    expect(toShareFailure(new Error('boom'))).toEqual({ failure: 'failed' })
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })
})
