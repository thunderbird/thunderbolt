/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/// <reference types="vite/client" />

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
interface ImportMetaEnv {
  readonly VITE_THUNDERBOLT_CLOUD_URL?: string
  readonly VITE_AUTH_MODE?: 'thunderbolt' | 'sso'
  readonly VITE_AUTH_ENABLE_ANONYMOUS?: 'true' | 'false'
  readonly VITE_APP_VERSION?: string
  /** Boot decision: when 'true', standalone mode is reachable. v1 production: 'false'. */
  readonly VITE_STANDALONE_MODE_ENABLED?: 'true' | 'false'
  /** Boot decision: when 'true', the mode picker lets the user point at a custom server URL. v1 production: 'false'. */
  readonly VITE_ALLOW_USER_ADDED_SERVERS?: 'true' | 'false'
}

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
interface ImportMeta {
  readonly env: ImportMetaEnv
}
