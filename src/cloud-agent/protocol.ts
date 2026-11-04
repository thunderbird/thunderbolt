/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { CloudConversationState, CloudRunStatus } from '@shared/cloud-agent/contracts'

/** Keep the server projection monotonic when a reconnect overlaps an older poll. */
export const latestCloudProjection = <T extends CloudConversationState>(previous: T | undefined, incoming: T): T => {
  if (!previous || previous.conversation.id !== incoming.conversation.id) {
    return incoming
  }
  if (previous.cursor > incoming.cursor) {
    return previous
  }
  if (previous.cursor === incoming.cursor) {
    const changedAt = (state: CloudConversationState) =>
      state.runs.reduce(
        (latest, run) => (run.updatedAt > latest ? run.updatedAt : latest),
        state.conversation.updatedAt,
      )
    if (changedAt(previous) > changedAt(incoming)) {
      return previous
    }
    const hasOlderDecision = incoming.approvals.some(
      (approval) =>
        approval.status === 'pending' &&
        previous.approvals.some((old) => old.id === approval.id && old.status !== 'pending'),
    )
    if (hasOlderDecision) {
      return previous
    }
  }
  return incoming
}

/** Pending and stopping runs remain active until the server confirms a terminal state. */
export const isCloudRunActive = (status: CloudRunStatus): boolean =>
  status === 'queued' || status === 'running' || status === 'awaiting-approval' || status === 'stop-requested'
