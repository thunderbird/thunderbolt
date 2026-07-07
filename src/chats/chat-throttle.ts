/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Throttle intervals (ms) for `useChat({ experimental_throttle })` subscribers.
 *
 * Every streamed token notifies every `useChat` subscriber, and each
 * notification re-renders the subscribing component (message renderers re-parse
 * markdown, re-diff large trees). Unthrottled, that is O(message length) work
 * per token across 8 subscribers. `experimental_throttle` coalesces the SDK's
 * *messages* callback to a trailing-edge interval, so a component re-renders at
 * most once per interval during a stream instead of once per token.
 *
 * Correctness notes (verified against `@ai-sdk/react` + `throttleit`):
 * - The throttle is trailing-edge: after the last delta the pending timer still
 *   fires, and React re-reads the live snapshot — so the final, complete message
 *   is always delivered. No truncated last frame, no lost data.
 * - `status` and `error` use *separate, unthrottled* SDK subscriptions, so
 *   status transitions (`submitted` → `streaming` → `ready`) still propagate
 *   instantly regardless of the value here. Status-only consumers can therefore
 *   take a large interval for free.
 * - `onFinish` (chat-instance) reads from the `Chat` instance directly, not from
 *   a throttled React snapshot, so message persistence is unaffected.
 */

/** Visible message renderers that must feel live as tokens stream. Paced faster
 *  than word arrival (smoothStream releases words every ~10ms in `runStreamText`)
 *  so text grows in small, frequent steps — a fluid word-by-word cadence
 *  (~25 paints/s) rather than chunky ~100ms batches. Still coalesces the many
 *  per-word notifications into one render per interval, keeping per-token work
 *  bounded across all `useChat` subscribers. */
export const messageRenderThrottleMs = 40

/** Consumers that read messages for bookkeeping (scroll, partial-save, input
 *  context, automation) — a coarser cadence is invisible and cheaper. */
export const messageBookkeepingThrottleMs = 150

/** Status-only consumers that never read message content. The large interval
 *  only bounds otherwise-wasted message-driven re-renders; their `status`
 *  reads stay instant via the unthrottled status subscription. */
export const statusOnlyThrottleMs = 500

/**
 * Delay (ms) between words released by `smoothStream` on the built-in provider
 * stream (see `runStreamText` in `src/ai/fetch.ts`). smoothStream re-paces the
 * model's text/reasoning deltas to a steady word-by-word cadence so a fast model
 * (or a bursty network chunk) surfaces as fluid typing rather than one large
 * jump. Kept at or below {@link messageRenderThrottleMs} so a fresh word is
 * always ready each paint — words arriving no slower than the render cadence is
 * what makes text advance every frame instead of stuttering.
 */
export const smoothStreamWordDelayMs = 10
