/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useSettings } from '@/hooks/use-settings'

/** Keep experimental providers hidden until their preview feature is enabled. */
export const useProviderVisibility = () => {
  const { experimentalFeatureOtari } = useSettings({ experimental_feature_otari: false })
  const otariEnabled = experimentalFeatureOtari.value
  return {
    otariEnabled,
    isLoading: experimentalFeatureOtari.isLoading,
    isProviderVisible: (provider: string) => provider !== 'otari' || otariEnabled,
  }
}
