/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { oauthReturnPath } from './oauth-return-route'

test.each(['/chats/new', '/chats/thread-1?project=work#latest', '/settings/search'])(
  'preserves the original route %s',
  (path) => {
    expect(oauthReturnPath(path)).toBe(path)
  },
)
test.each([
  42,
  {},
  undefined,
  null,
  'https://evil.example',
  '//evil.example',
  '/\\evil.example',
  '/oauth/callback?code=secret',
  '/chats/../oauth/tinfoil',
  '/\n/evil.example',
])('rejects unsafe or recursive return routes: %s', (path) => {
  expect(oauthReturnPath(path)).toBe('/settings/connections')
})
