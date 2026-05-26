/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Backend-internal error codes returned by `/agents`. The wire shape matches
 * other authenticated routes (`{ error, code }`).
 */
export type AgentsErrorCode = 'ANONYMOUS_DISCOVERY_FORBIDDEN'

export type AgentsErrorResponse = {
  error: string
  code: AgentsErrorCode
}
