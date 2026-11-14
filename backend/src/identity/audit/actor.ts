/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AuditEventInput } from './write'

type AuthenticatedSession = { user: { id: string }; session: { id: string } }

/**
 * Who a signed-in request acts as: the API key when it carried one (the api-key plugin makes a
 * session whose id is the key's id), the user otherwise. An API key's events keep its owner in
 * `metadata.userId`.
 */
export const sessionActor = (
  { user, session }: AuthenticatedSession,
  headers: Headers,
): Pick<AuditEventInput, 'actor' | 'metadata'> =>
  headers.has('x-api-key')
    ? { actor: { type: 'api_key', id: session.id }, metadata: { userId: user.id } }
    : { actor: { type: 'user', id: user.id } }
