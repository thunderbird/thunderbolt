/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { UserConfig } from 'vite'

/** Reuse the app's Vite plugins without loading local deployment settings or binding outside loopback. */
export const isolatedFrontendConfig = (config: UserConfig, port: number): UserConfig => ({
  ...config,
  envDir: false,
  server: { ...config.server, host: '127.0.0.1', port, strictPort: true },
})
