/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * React-router `location.state` key carrying a message id from the Cmd+K
 * search palette to the chat page.
 *
 * When a message search result is selected, the palette navigates to the
 * message's chat with `state: { [scrollToMessageStateKey]: message.id }`.
 * The value is a plain string (the `chat_messages.id`, which equals the
 * `[data-message-id]` DOM attribute) — `useConsumeNavState` only fires for
 * string values, so no JSON encoding is needed. The chat page consumes it
 * once to scroll to and briefly flash the target message.
 */
export const scrollToMessageStateKey = 'scrollToMessageId'
