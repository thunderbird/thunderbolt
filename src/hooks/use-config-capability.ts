/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConfigStore, type AppConfig } from '@/api/config-store'
import { useLocalProviders } from './use-local-providers'

/** Keep local capabilities available until the user authenticates to an optional server. */
export const useConfigCapability = (selector: (config: AppConfig, localProviders: boolean) => boolean): boolean => {
  const localProviders = useLocalProviders()
  return useConfigStore((state) => selector(state.config, localProviders))
}
