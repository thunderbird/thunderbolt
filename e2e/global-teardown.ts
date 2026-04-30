/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { OAuth2Server } from 'oauth2-mock-server'

const globalTeardown = async () => {
  const server = (globalThis as Record<string, unknown>).__oidcServer as OAuth2Server | undefined
  if (server) {
    await server.stop()
    console.log('Mock OIDC server stopped')
  }
}

export default globalTeardown
