/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defaultOtariOrigin } from '@/lib/otari-auth'
import type { ProviderConnection } from './types'

const accountUrls = {
  tinfoil: 'https://dash.tinfoil.sh/',
  privatemode: 'https://portal.privatemode.ai/',
  openrouter: 'https://openrouter.ai/settings/keys',
  anthropic: 'https://platform.claude.com/',
  exa: 'https://dashboard.exa.ai/',
  brave: 'https://api-dashboard.search.brave.com/',
  tavily: 'https://app.tavily.com/',
}

/** Open the account that owns this connection, including custom Otari deployments. */
export const getProviderAccountUrl = (connection: Pick<ProviderConnection, 'provider' | 'authMethod' | 'url'>) => {
  if (connection.provider === 'custom') {
    return null
  }
  if (connection.provider === 'otari') {
    return connection.url ? new URL(connection.url).origin : defaultOtariOrigin
  }
  if (connection.provider === 'openai') {
    return connection.authMethod === 'oauth' ? 'https://chatgpt.com/' : 'https://platform.openai.com/'
  }
  return accountUrls[connection.provider]
}
