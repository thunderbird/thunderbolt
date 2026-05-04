/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { OAuth2Server } from 'oauth2-mock-server'
import type { Server } from 'node:http'

const globalTeardown = async () => {
  const oidcServer = (globalThis as Record<string, unknown>).__oidcServer as OAuth2Server | undefined
  if (oidcServer) {
    await oidcServer.stop()
    console.log('Mock OIDC server stopped')
  }

  const samlServer = (globalThis as Record<string, unknown>).__samlServer as Server | undefined
  if (samlServer) {
    await new Promise<void>((resolve) => samlServer.close(() => resolve()))
    console.log('Mock SAML IdP stopped')
  }
}

export default globalTeardown
