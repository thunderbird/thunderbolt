/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Notification emails ride committed transactions — a send failure is logged, never surfaced. */
export const notifyBestEffort = (label: string, send: Promise<void>): void => {
  send.catch((err) => console.error(`[email] ${label} failed:`, err))
}
