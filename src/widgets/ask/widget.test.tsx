/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto'
import { type ChatSession, useChatStore } from '@/chats/chat-store'
import { usePendingPromptStore } from '@/chats/pending-prompt-store'
import { DatabaseProvider } from '@/contexts'
import { getMessageCache } from '@/dal/chat-messages'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { chatMessagesTable } from '@/db/tables'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { waitForElement } from '@/test-utils/powersync-reactivity-test'
import { getClock } from '@/testing-library'
import { eq } from 'drizzle-orm'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { ReactNode } from 'react'
import { askStorageKey, askStorageKeys, type AskCacheEntry, type AskData } from './lib'
import { AskSequence } from './widget'

const messageId = 'assistant-quiz'

const quiz: AskData[] = [
  {
    prompt: 'Which protocol sends mail?',
    mode: 'single',
    explanation: 'SMTP handles sending.',
    options: [
      { id: 'smtp', text: 'SMTP', isCorrect: true },
      { id: 'imap', text: 'IMAP' },
    ],
  },
  {
    prompt: 'What should we cover next?',
    mode: 'choice',
    options: [
      { id: 'calendar', text: 'Calendar' },
      { id: 'filters', text: 'Filters' },
    ],
  },
  {
    prompt: 'Which protocol keeps mail on the server?',
    mode: 'single',
    options: [
      { id: 'imap', text: 'IMAP', isCorrect: true },
      { id: 'pop3', text: 'POP3' },
    ],
  },
]

const initialChatState = useChatStore.getState()

const sendMessage = mock(async (_: { text: string }) => {})

const Providers = ({ children }: { children: ReactNode }) => (
  <DatabaseProvider db={getDb()}>
    <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
  </DatabaseProvider>
)

/** Polls (with the shared fake clock) until `check` holds. */
const waitUntil = (check: () => boolean) => waitForElement(() => (check() ? document.body : null))

const find = (text: string | RegExp) => waitForElement(() => screen.queryByText(text))
const findButton = (name: string) => waitForElement(() => screen.queryByRole('button', { name }))

const storedAnswerCount = async () => Object.keys((await getMessageCache(getDb(), messageId))?.cache ?? {}).length

/** Waits (advancing the shared fake clock) until `count` answers are persisted; returns the final count. */
const waitForStoredAnswers = async (count: number) => {
  for (let attempt = 0; attempt < 100 && (await storedAnswerCount()) < count; attempt++) {
    await act(() => getClock().tickAsync(10))
  }
  return storedAnswerCount()
}

/** Renders a whole quiz as one sequence, as the chat renderer does for back-to-back asks. */
const renderQuiz = (asks: AskData[] = quiz) =>
  render(<AskSequence asks={asks} offset={0} messageAsks={asks} messageId={messageId} />, { wrapper: Providers })

const savedEntry = (ask: AskData, optionId: string): AskCacheEntry => ({
  prompt: ask.prompt,
  mode: ask.mode,
  selectedIds: [optionId],
  chosen: [ask.options.find((option) => option.id === optionId)?.text ?? optionId],
  matched: ask.options.find((option) => option.id === optionId)?.isCorrect ?? (ask.mode === 'choice' ? null : false),
})

const saveAnswers = (cache: Record<string, AskCacheEntry>) =>
  getDb().update(chatMessagesTable).set({ cache }).where(eq(chatMessagesTable.id, messageId))

const navigationGuardMs = 400

const isDisabled = (element: HTMLElement | null) => (element?.closest('button') as HTMLButtonElement | null)?.disabled

/** The card's primary action: Next on an ungraded step with a step after it, Submit otherwise. */
const actionButton = () => screen.getByRole('button', { name: /^(Next|Submit)$/ })

/**
 * Answers the current single-select step as the user does. A graded `single`
 * is graded on the tap, which locks its options; an ungraded `choice` shows the
 * pick, and the action button commits it.
 */
const answer = async (option: string) => {
  // A step just reached by navigating ignores answers for a moment (the double-click guard), as a person's pause would clear.
  await act(() => getClock().tickAsync(navigationGuardMs))
  const row = await find(option)
  fireEvent.click(row)
  if (!isDisabled(row)) {
    fireEvent.click(actionButton())
  }
}
const nextQuestion = () => screen.getByRole('button', { name: 'Next question' })

/** Clicks › once the saved answer has reached the sequence and enabled it. */
const goNext = async () => {
  await waitUntil(() => isDisabled(screen.queryByRole('button', { name: 'Next question' })) === false)
  fireEvent.click(nextQuestion())
}

describe('AskSequence', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)

  beforeEach(async () => {
    await resetTestDatabase()
    await getDb().insert(chatMessagesTable).values({ id: messageId, chatThreadId: 'thread', role: 'assistant' })
    sendMessage.mockClear()
    const session = { id: 'session', chatInstance: { sendMessage } } as unknown as ChatSession
    useChatStore.setState({ currentSessionId: 'session', sessions: new Map([['session', session]]) })
  })

  afterEach(() => {
    cleanup()
    useChatStore.setState(initialChatState, true)
  })

  it('shows one question at a time and sends every answer once, when the last one is submitted', async () => {
    renderQuiz()

    expect(await find('Question 1 of 3')).toBeTruthy()
    expect(screen.queryByText('What should we cover next?')).toBeNull()

    // A graded step grades on the tap and keeps its feedback on screen until the step control moves on.
    await answer('SMTP')
    expect(await find('SMTP handles sending.')).toBeTruthy()
    await goNext()

    // An ungraded `choice` step is picked, then Next saves it and moves straight on.
    await answer('Filters')
    expect(await find('Question 3 of 3')).toBeTruthy()
    expect(sendMessage).not.toHaveBeenCalled()

    await answer('IMAP')
    await waitUntil(() => sendMessage.mock.calls.length > 0)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0][0].text).toBe(
      [
        '1. Which protocol sends mail? — SMTP',
        '2. What should we cover next? — Filters',
        '3. Which protocol keeps mail on the server? — IMAP',
      ].join('\n'),
    )
    expect(isDisabled(nextQuestion())).toBe(true)
    expect(await waitForStoredAnswers(3)).toBe(3)
  })

  it('keeps the last feedback on screen, then reviews every answer on "See all answers"', async () => {
    renderQuiz()
    await answer('SMTP')
    await goNext()
    await answer('Filters')
    await answer('POP3')

    expect(await find('Got it, working on that next.')).toBeTruthy()
    fireEvent.click(await findButton('See all answers'))

    expect(await find('Your answers')).toBeTruthy()
    for (const text of [quiz[0].prompt, quiz[1].prompt, quiz[2].prompt, 'SMTP handles sending.', 'Filters', 'POP3']) {
      expect(screen.getByText(text)).toBeTruthy()
    }
    expect(screen.getByRole('img', { name: 'Matches the answer' })).toBeTruthy()
    expect(screen.getByRole('img', { name: "Doesn't match the answer" })).toBeTruthy()
  })

  it('keeps a finished group navigable, without the review, while another group in the message is open', async () => {
    const [first, second, third] = quiz
    await saveAnswers({
      [askStorageKey(first)]: savedEntry(first, 'smtp'),
      [askStorageKey(second)]: savedEntry(second, 'filters'),
    })
    const renderFirstGroup = () =>
      render(
        <AskSequence asks={[first, second]} offset={0} messageAsks={[first, second, third]} messageId={messageId} />,
        {
          wrapper: Providers,
        },
      )

    const open = renderFirstGroup()
    expect(await find('Question 2 of 2')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'See all answers' })).toBeNull()
    fireEvent.click(await findButton('Previous question'))
    expect(await find('Question 1 of 2')).toBeTruthy()
    open.unmount()

    await saveAnswers({
      [askStorageKey(first)]: savedEntry(first, 'smtp'),
      [askStorageKey(second)]: savedEntry(second, 'filters'),
      [askStorageKey(third)]: savedEntry(third, 'imap'),
    })
    renderFirstGroup()
    expect(await find('Your answers')).toBeTruthy()
  })

  it('opens on the review when every step is already answered, without sending', async () => {
    const keys = askStorageKeys(quiz)
    await saveAnswers({
      [keys[0]]: savedEntry(quiz[0], 'smtp'),
      [keys[1]]: savedEntry(quiz[1], 'calendar'),
      [keys[2]]: savedEntry(quiz[2], 'imap'),
    })
    renderQuiz()

    expect(await find('Your answers')).toBeTruthy()
    expect(screen.getByText('Calendar')).toBeTruthy()
    expect(screen.queryByText(/Question \d of/)).toBeNull()
    expect(screen.queryByText('Got it, working on that next.')).toBeNull()
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('shows no sent note on intermediate steps', async () => {
    renderQuiz()
    await answer('SMTP')
    expect(await find('SMTP handles sending.')).toBeTruthy()
    expect(screen.queryByText('Got it, working on that next.')).toBeNull()
  })

  it('moves focus to the new prompt after the step control and after an ungraded step advances', async () => {
    renderQuiz()
    expect(document.activeElement).not.toBe(await find(quiz[0].prompt))

    await answer('SMTP')
    await goNext()
    expect(document.activeElement).toBe(await find(quiz[1].prompt))

    await answer('Filters')
    expect(document.activeElement).toBe(await find(quiz[2].prompt))
  })

  it('answers and stores two identical asks separately', async () => {
    renderQuiz([quiz[0], quiz[0]])
    await answer('SMTP')
    await goNext()

    expect(await find('Question 2 of 2')).toBeTruthy()
    expect(isDisabled(screen.getByText('IMAP'))).toBe(false)
    await answer('IMAP')

    await waitUntil(() => sendMessage.mock.calls.length > 0)
    expect(sendMessage.mock.calls[0][0].text).toBe(
      ['1. Which protocol sends mail? — SMTP', '2. Which protocol sends mail? — IMAP'].join('\n'),
    )
    expect(await waitForStoredAnswers(2)).toBe(2)
  })

  describe('asks split by text into separate sequences', () => {
    const [first, second] = [quiz[0], quiz[2]]
    const messageAsks = [first, second]

    const renderSplit = () =>
      render(
        <>
          <AskSequence asks={[first]} offset={0} messageAsks={messageAsks} messageId={messageId} />
          <p>Now a harder one:</p>
          <AskSequence asks={[second]} offset={1} messageAsks={messageAsks} messageId={messageId} />
        </>,
        { wrapper: Providers },
      )

    it('send one turn, in message order, once the last of them is answered', async () => {
      renderSplit()

      // Both cards offer "IMAP", each graded on the tap.
      await waitUntil(() => screen.queryAllByText('IMAP').length === 2)
      fireEvent.click(screen.getAllByText('IMAP')[0])
      expect(await waitForStoredAnswers(1)).toBe(1)
      expect(sendMessage).not.toHaveBeenCalled()
      expect(screen.queryByText('Got it, working on that next.')).toBeNull()

      fireEvent.click(screen.getAllByText('IMAP')[1])

      await waitUntil(() => sendMessage.mock.calls.length > 0)
      expect(sendMessage).toHaveBeenCalledTimes(1)
      expect(sendMessage.mock.calls[0][0].text).toBe(
        ['1. Which protocol sends mail? — IMAP', '2. Which protocol keeps mail on the server? — IMAP'].join('\n'),
      )
      expect(screen.getAllByText('Got it, working on that next.')).toHaveLength(1)
      expect(await waitForStoredAnswers(2)).toBe(2)
    })

    it('send once the remaining ask of a historical message is answered', async () => {
      await saveAnswers({ [askStorageKey(second)]: savedEntry(second, 'pop3') })
      renderSplit()

      await answer('SMTP')
      await waitUntil(() => sendMessage.mock.calls.length > 0)
      expect(sendMessage.mock.calls[0][0].text).toBe(
        ['1. Which protocol sends mail? — SMTP', '2. Which protocol keeps mail on the server? — POP3'].join('\n'),
      )
    })
  })

  it('persists each answer and reopens on the first unanswered question', async () => {
    const first = renderQuiz()
    await answer('SMTP')
    expect(await waitForStoredAnswers(1)).toBe(1)
    first.unmount()

    renderQuiz()
    expect(await find('Question 2 of 3')).toBeTruthy()
  })

  it('a lone graded ask sends its answer as a user turn', async () => {
    renderQuiz([quiz[0]])

    await answer('IMAP')
    await waitUntil(() => sendMessage.mock.calls.length > 0)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0][0].text).toBe('IMAP')
    expect(await find('Got it, working on that next.')).toBeTruthy()
    expect(screen.queryByText(/Question \d of/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'See all answers' })).toBeNull()
  })

  it('an answered lone ask comes back read-only after a reload, even if its send failed', async () => {
    await saveAnswers({ [askStorageKey(quiz[1])]: savedEntry(quiz[1], 'filters') })
    renderQuiz([quiz[1]])

    expect(isDisabled(await find('Filters'))).toBe(true)
    expect(isDisabled(screen.getByText('Other…'))).toBe(true)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('a request that fails inside the chat shows neither the sent note nor Try again, and stays locked', async () => {
    const chatInstance = {
      error: undefined as Error | undefined,
      sendMessage: mock(async (_: { text: string }) => {
        // As `Chat.sendMessage` does: it catches the request error and resolves.
        chatInstance.error = new Error('Upstream 500')
      }),
    }
    const session = { id: 'session', chatInstance } as unknown as ChatSession
    useChatStore.setState({ currentSessionId: 'session', sessions: new Map([['session', session]]) })
    renderQuiz([quiz[1]])

    await answer('Filters')
    await waitUntil(() => chatInstance.sendMessage.mock.calls.length > 0)
    await act(() => getClock().tickAsync(50))

    expect(chatInstance.sendMessage).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Got it, working on that next.')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(isDisabled(screen.getByText('Calendar'))).toBe(true)
  })

  it('a send that throws before the request says so and resends the same answers on Try again', async () => {
    sendMessage.mockImplementationOnce(async () => {
      throw new Error('No model selected')
    })
    renderQuiz([quiz[0]])

    await answer('SMTP')
    expect(await find('Your answers couldn’t be sent.')).toBeTruthy()
    expect(screen.queryByText('Got it, working on that next.')).toBeNull()
    fireEvent.click(await findButton('Try again'))
    await waitUntil(() => sendMessage.mock.calls.length > 1)

    expect(sendMessage.mock.calls.map(([call]) => call.text)).toEqual(['SMTP', 'SMTP'])
    expect(await find('Got it, working on that next.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('drops Try again once the thread has moved on, so a stale turn is never posted', async () => {
    sendMessage.mockImplementationOnce(async () => {
      throw new Error('No model selected')
    })
    // One QueryClient across the rerender, so the card keeps its failed send rather than reloading.
    const client = new QueryClient()
    const Stable = ({ children }: { children: ReactNode }) => (
      <DatabaseProvider db={getDb()}>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </DatabaseProvider>
    )
    const sequence = (hasReply: boolean) => (
      <AskSequence asks={[quiz[0]]} offset={0} messageAsks={[quiz[0]]} messageId={messageId} hasReply={hasReply} />
    )
    const view = render(sequence(false), { wrapper: Stable })
    await answer('SMTP')
    expect(await findButton('Try again')).toBeTruthy()

    view.rerender(sequence(true))
    await waitUntil(() => screen.queryByRole('button', { name: 'Try again' }) === null)
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(screen.getByText('Your answers couldn’t be sent.')).toBeTruthy()
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  describe('going back', () => {
    it('shows an answered graded step read-only and an ungraded one still editable', async () => {
      renderQuiz()
      await answer('SMTP')
      await goNext()
      await answer('Filters')
      expect(await find('Question 3 of 3')).toBeTruthy()
      expect(await waitForStoredAnswers(2)).toBe(2)

      fireEvent.click(screen.getByRole('button', { name: 'Previous question' }))
      expect(await find('Question 2 of 3')).toBeTruthy()
      expect(isDisabled(screen.getByText('Calendar'))).toBe(false)

      fireEvent.click(screen.getByRole('button', { name: 'Previous question' }))
      expect(await find('Question 1 of 3')).toBeTruthy()
      expect(isDisabled(screen.getByText('IMAP'))).toBe(true)
      expect(screen.getByText('SMTP handles sending.')).toBeTruthy()
      expect(isDisabled(screen.getByRole('button', { name: 'Previous question' }))).toBe(true)
    })

    it('an edited earlier answer replaces the saved one, sends nothing, and is what goes out', async () => {
      renderQuiz()
      await answer('SMTP')
      await goNext()
      await answer('Filters')
      fireEvent.click(await findButton('Previous question'))
      await answer('Calendar')

      expect(await find('Question 3 of 3')).toBeTruthy()
      expect(await waitForStoredAnswers(2)).toBe(2)
      const cache = (await getMessageCache(getDb(), messageId))?.cache as Record<string, AskCacheEntry>
      expect(cache[askStorageKeys(quiz)[1]].chosen).toEqual(['Calendar'])
      expect(sendMessage).not.toHaveBeenCalled()

      await answer('IMAP')
      await waitUntil(() => sendMessage.mock.calls.length > 0)
      expect(sendMessage.mock.calls[0][0].text).toContain('2. What should we cover next? — Calendar')
    })

    it('a double tap on the last single-answer step grades and sends once', async () => {
      renderQuiz([quiz[0]])
      const option = await find('IMAP')
      act(() => {
        fireEvent.click(option)
        fireEvent.click(option)
      })
      fireEvent.click(await find('SMTP'))

      await waitUntil(() => sendMessage.mock.calls.length > 0)
      await act(() => getClock().tickAsync(50))
      expect(sendMessage).toHaveBeenCalledTimes(1)
      expect(sendMessage.mock.calls[0][0].text).toBe('IMAP')
    })

    it('after a failed send the answers lock, and Try again resends them', async () => {
      sendMessage.mockImplementationOnce(async () => {
        throw new Error('No model selected')
      })
      const asks = [quiz[1], { ...quiz[1], prompt: 'And after that?' }]
      renderQuiz(asks)
      await answer('Filters')
      await answer('Calendar')
      await findButton('Try again')

      fireEvent.click(screen.getByRole('button', { name: 'Previous question' }))
      expect(await find('Question 1 of 2')).toBeTruthy()
      expect(isDisabled(screen.getByText('Calendar'))).toBe(true)
      fireEvent.click(await findButton('Try again'))
      await waitUntil(() => sendMessage.mock.calls.length > 1)

      expect(sendMessage.mock.calls[1][0].text).toBe(
        ['1. What should we cover next? — Filters', '2. And after that? — Calendar'].join('\n'),
      )
    })

    it('a graded answer moves focus to the Next button under it, so the keyboard carries on forward', async () => {
      renderQuiz()
      await answer('SMTP')
      expect(document.activeElement).toBe(await findButton('Next'))
    })

    it('a second pick and press in the same frame as Submit on the last step keep the first answer', async () => {
      renderQuiz([quiz[1]])
      const [filters, calendar] = [await find('Filters'), screen.getByText('Calendar')]
      fireEvent.click(filters)
      const submit = actionButton()
      act(() => {
        fireEvent.click(submit)
        fireEvent.click(calendar)
        fireEvent.click(submit)
      })

      await waitUntil(() => sendMessage.mock.calls.length > 0)
      expect(await waitForStoredAnswers(1)).toBe(1)
      expect(sendMessage).toHaveBeenCalledTimes(1)
      expect(sendMessage.mock.calls[0][0].text).toBe('Filters')
      const cache = (await getMessageCache(getDb(), messageId))?.cache as Record<string, AskCacheEntry>
      expect(cache[askStorageKey(quiz[1])].chosen).toEqual(['Filters'])
      expect(filters.closest('button')?.getAttribute('aria-pressed')).toBe('true')
      expect(calendar.closest('button')?.getAttribute('aria-pressed')).toBe('false')
    })

    it('locks answered ungraded steps once the thread has moved on, leaving open ones answerable', async () => {
      const keys = askStorageKeys(quiz)
      await saveAnswers({ [keys[0]]: savedEntry(quiz[0], 'smtp'), [keys[1]]: savedEntry(quiz[1], 'calendar') })
      render(<AskSequence asks={quiz} offset={0} messageAsks={quiz} messageId={messageId} hasReply />, {
        wrapper: Providers,
      })

      expect(await find('Question 3 of 3')).toBeTruthy()
      expect(isDisabled(screen.getByText('POP3'))).toBe(false)
      fireEvent.click(screen.getByRole('button', { name: 'Previous question' }))
      expect(isDisabled(await find('Filters'))).toBe(true)
    })
  })

  describe('"Other…"', () => {
    afterEach(() => usePendingPromptStore.setState({ promptsByThread: {} }))

    it('a lone choice hands the answer to the composer, focused, instead of sending', async () => {
      renderQuiz([quiz[1]])
      await answer('Other…')

      expect(await find('Finish your answer in the message box.')).toBeTruthy()
      expect(usePendingPromptStore.getState().promptsByThread.session).toEqual({ text: '', focus: true })
      expect(sendMessage).not.toHaveBeenCalled()
      expect(await waitForStoredAnswers(1)).toBe(1)
      const cache = (await getMessageCache(getDb(), messageId))?.cache as Record<string, AskCacheEntry>
      expect(cache[askStorageKey(quiz[1])]).toMatchObject({ other: true, chosen: [] })
    })

    it('waits for the last answer, then drafts every line with the "Other…" one left open', async () => {
      renderQuiz([quiz[1], quiz[0]])
      await answer('Other…')
      expect(usePendingPromptStore.getState().promptsByThread.session).toBeUndefined()

      await answer('SMTP')
      await waitUntil(() => usePendingPromptStore.getState().promptsByThread.session !== undefined)
      expect(usePendingPromptStore.getState().promptsByThread.session?.text).toBe(
        ['1. What should we cover next? — ', '2. Which protocol sends mail? — SMTP'].join('\n'),
      )
      expect(sendMessage).not.toHaveBeenCalled()
    })

    it('a reload before the composer is sent restores the hand-off read-only, without handing off again', async () => {
      await saveAnswers({
        [askStorageKey(quiz[1])]: { ...savedEntry(quiz[1], 'calendar'), selectedIds: [], chosen: [], other: true },
      })
      renderQuiz([quiz[1]])

      const other = await find('Other…')
      expect(isDisabled(other)).toBe(true)
      expect(other.closest('button')?.getAttribute('aria-pressed')).toBe('true')
      expect(isDisabled(screen.getByText('Calendar'))).toBe(true)
      expect(usePendingPromptStore.getState().promptsByThread.session).toBeUndefined()
    })

    it('restores as picked, and the review points to the message', async () => {
      const keys = askStorageKeys([quiz[1], quiz[0]])
      await saveAnswers({
        [keys[0]]: { ...savedEntry(quiz[1], 'calendar'), selectedIds: [], chosen: [], other: true },
        [keys[1]]: savedEntry(quiz[0], 'smtp'),
      })
      renderQuiz([quiz[1], quiz[0]])

      expect(await find('Other (in your message)')).toBeTruthy()
    })
  })

  describe('a message the thread has moved on from', () => {
    afterEach(() => usePendingPromptStore.setState({ promptsByThread: {} }))

    const renderReplied = (asks: AskData[]) =>
      render(<AskSequence asks={asks} offset={0} messageAsks={asks} messageId={messageId} hasReply />, {
        wrapper: Providers,
      })

    it('saves the answer that completes it, without sending or a send note, and the next note carries it', async () => {
      renderReplied([quiz[1]])
      await answer('Filters')

      expect(await waitForStoredAnswers(1)).toBe(1)
      await act(() => getClock().tickAsync(50))
      expect(sendMessage).not.toHaveBeenCalled()
      expect(screen.queryByText('Got it, working on that next.')).toBeNull()
      expect(screen.queryByRole('alert')).toBeNull()
    })

    it('still hands an "Other…" answer to the composer, but sends nothing itself', async () => {
      renderReplied([quiz[1]])
      await answer('Other…')

      expect(await waitForStoredAnswers(1)).toBe(1)
      expect(usePendingPromptStore.getState().promptsByThread.session).toMatchObject({ focus: true })
      expect(await find('Finish your answer in the message box.')).toBeTruthy()
      await act(() => getClock().tickAsync(50))
      expect(sendMessage).not.toHaveBeenCalled()
      usePendingPromptStore.setState({ promptsByThread: {} })
    })
  })

  it('disables › while a revisited step has an unsaved edit; the button under it saves and moves on', async () => {
    renderQuiz()
    await answer('SMTP')
    await goNext()
    await answer('Filters')
    expect(await find('Question 3 of 3')).toBeTruthy()
    expect(await waitForStoredAnswers(2)).toBe(2)

    fireEvent.click(screen.getByRole('button', { name: 'Previous question' }))
    expect(await find('Question 2 of 3')).toBeTruthy()
    expect(isDisabled(nextQuestion())).toBe(false)

    await act(() => getClock().tickAsync(navigationGuardMs))
    fireEvent.click(screen.getByText('Calendar'))
    expect(isDisabled(nextQuestion())).toBe(true)

    fireEvent.click(actionButton())
    expect(await find('Question 3 of 3')).toBeTruthy()
    await answer('IMAP')
    await waitUntil(() => sendMessage.mock.calls.length > 0)
    expect(sendMessage.mock.calls[0][0].text).toContain('2. What should we cover next? — Calendar')
  })

  it('ignores a tap on the next card just after Next, so a double click cannot grade it', async () => {
    renderQuiz([quiz[1], quiz[0]])
    fireEvent.click(await find('Filters'))
    fireEvent.click(actionButton())
    expect(await find('Question 2 of 2')).toBeTruthy()

    // The double click's second press lands on an option of the graded card.
    fireEvent.click(screen.getByText('IMAP'))
    expect(screen.queryByText('SMTP handles sending.')).toBeNull()
    expect(isDisabled(screen.getByText('IMAP'))).toBe(false)

    await act(() => getClock().tickAsync(navigationGuardMs))
    fireEvent.click(screen.getByText('SMTP'))
    expect(await find('SMTP handles sending.')).toBeTruthy()
  })

  describe('Skip', () => {
    const optionalChoice = { ...quiz[1], optional: true }

    it('skips an optional question, which still counts and keeps its numbered line', async () => {
      renderQuiz([optionalChoice, quiz[0]])
      fireEvent.click(await findButton('Skip'))

      expect(await find('Question 2 of 2')).toBeTruthy()
      await answer('SMTP')
      await waitUntil(() => sendMessage.mock.calls.length > 0)
      expect(sendMessage.mock.calls[0][0].text).toBe(
        ['1. What should we cover next? — skipped', '2. Which protocol sends mail? — SMTP'].join('\n'),
      )
      fireEvent.click(await findButton('See all answers'))
      expect(await find('Skipped')).toBeTruthy()
    })

    it('going back to a skipped question still lets the user move on, and a later pick replaces the skip', async () => {
      renderQuiz([optionalChoice, quiz[0], quiz[2]])
      fireEvent.click(await findButton('Skip'))
      expect(await find('Question 2 of 3')).toBeTruthy()
      expect(await waitForStoredAnswers(1)).toBe(1)

      fireEvent.click(screen.getByRole('button', { name: 'Previous question' }))
      expect(await find('Question 1 of 3')).toBeTruthy()
      await waitUntil(() => isDisabled(screen.queryByRole('button', { name: 'Next question' })) === false)
      // No Submit: the unchanged skip is the saved answer, so the bottom Next just moves on.
      expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull()
      expect(isDisabled(screen.getByRole('button', { name: 'Next' }))).toBe(false)

      await answer('Calendar')
      expect(await find('Question 2 of 3')).toBeTruthy()
      await answer('SMTP')
      await goNext()
      await answer('IMAP')
      await waitUntil(() => sendMessage.mock.calls.length > 0)
      expect(sendMessage.mock.calls[0][0].text.split('\n')[0]).toBe('1. What should we cover next? — Calendar')
    })

    it('is not offered on a lone ask, or on a question that is not optional', async () => {
      renderQuiz([optionalChoice])
      expect(await find(optionalChoice.prompt)).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull()
      cleanup()

      renderQuiz([quiz[1], quiz[0]])
      expect(await find(quiz[1].prompt)).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull()
    })
  })
})
