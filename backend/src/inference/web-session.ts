/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

type RequestContext = Readonly<{ request: Request }>

/** Reject personal access tokens on routes that require an authenticated web session. */
export const rejectPersonalAccessToken = ({ request }: RequestContext): Response | undefined =>
  request.headers.has('x-api-key')
    ? Response.json({ error: { code: 'WEB_LOGIN_REQUIRED' } }, { status: 403 })
    : undefined
