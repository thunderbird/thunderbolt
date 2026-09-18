/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createHmac } from 'crypto'

export const betterAuthTestSecret = 'better-auth-secret-12345678901234567890'

/** Sign a Better Auth bearer token for route tests. */
export const signTestToken = (token: string): string => {
  const signature = createHmac('sha256', betterAuthTestSecret).update(token).digest('base64')
  return `${token}.${signature}`
}
