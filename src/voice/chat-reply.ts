/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Chat-backed reply for the voice session (THU-688).
 *
 * Turns a voice turn into a real chat turn: sends the transcript through the
 * app's existing `Chat` instance (model, tools, history, persistence all reused)
 * and streams *this turn's* assistant message text back as deltas, so TTS starts
 * speaking mid-generation. Aborting the turn (a newer utterance supersedes it, or
 * the session stops) cancels the in-flight send via `chat.stop()`.
 *
 * We baseline on the message count before sending so we read the NEW assistant
 * message, not the previous turn's (which is still `messages[last]` until the
 * send appends).
 */
import type { ReplyFn } from '@/voice/session'

/** The slice of the AI SDK `Chat` this needs — kept structural so it's testable. */
export type ReplyChat = {
  sendMessage: (message: { text: string }) => Promise<void>
  readonly messages: ReadonlyArray<{ role: string; parts: ReadonlyArray<{ type: string; text?: string }> }>
  stop: () => Promise<void>
}

const pollMs = 40

/** Text of the assistant message for the turn that started at `baseline`, or ''. */
const turnAssistantText = (chat: ReplyChat, baseline: number): string => {
  const { messages } = chat
  if (messages.length <= baseline) {
    return ''
  } // no new messages yet
  const last = messages[messages.length - 1]
  if (last.role !== 'assistant') {
    return ''
  } // user message added, assistant not started
  return last.parts.reduce((text, part) => (part.type === 'text' ? text + (part.text ?? '') : text), '')
}

const timerWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * @param wait poll scheduler between reads — defaults to a real timer; inject a
 *   microtask resolver in tests (the happydom test env doesn't run `setTimeout`).
 */
export const createChatReply = (chat: ReplyChat, wait: (ms: number) => Promise<void> = timerWait): ReplyFn =>
  async function* (userText, signal) {
    const onAbort = () => void chat.stop()
    signal.addEventListener('abort', onAbort, { once: true })
    const baseline = chat.messages.length
    let emitted = 0
    let done = false
    let sendError: unknown = null
    void chat
      .sendMessage({ text: userText })
      .catch((error) => {
        sendError = error
      })
      .finally(() => {
        done = true
      })
    try {
      while (!signal.aborted) {
        const text = turnAssistantText(chat, baseline)
        if (text.length > emitted) {
          yield text.slice(emitted)
          emitted = text.length
        }
        if (done) {
          const finalText = turnAssistantText(chat, baseline)
          if (finalText.length > emitted) {
            yield finalText.slice(emitted)
          }
          // Surface a send failure so the session hits its error state instead of
          // returning a silent empty turn (no audio, no error). Skipped on abort —
          // there the rejection is our own chat.stop(), not a real failure.
          if (sendError && !signal.aborted) {
            throw sendError
          }
          return
        }
        await wait(pollMs)
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }
