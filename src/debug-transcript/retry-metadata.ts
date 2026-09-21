/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const emptyResponseRetryReason = 'empty-response'

/** Convert completed retries to total attempts made, including the current attempt. */
export const attemptsMadeFromCompletedRetries = (completedRetries: number): number => completedRetries + 1
