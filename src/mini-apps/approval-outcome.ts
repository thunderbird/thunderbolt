/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * How an approval request ended.
 *
 * A boolean before, which collapsed four different endings into one and told the
 * model the user had declined in all of them — including the three the user
 * never saw. "You declined that" about a prompt that timed out, or that was
 * swept when the app closed, is a plain falsehood in the transcript.
 *
 * Its own module so the chat store can type the queue entry without importing
 * the Mini App feature, and the feature can resolve it without importing the
 * store's type back.
 */
export type MiniAppApprovalOutcome =
  /** The user pressed Approve. */
  | 'approved'
  /** The user pressed Deny. */
  | 'denied'
  /** Nobody answered before the deadline, so it denied itself. */
  | 'expired'
  /**
   * There was nobody to ask: no live session for the originating chat, or the
   * app closed or re-handshaked while the call was queued.
   */
  | 'unavailable'
