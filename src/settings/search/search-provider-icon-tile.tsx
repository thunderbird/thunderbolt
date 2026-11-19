/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SiBrave } from '@icons-pack/react-simple-icons'
import exaLogoSrc from '@/assets/exa.svg'
import tavilyLogoSrc from '@/assets/tavily.svg'
import { IconTile } from '@/components/settings/icon-tile'
import type { SearchProvider } from '@/integrations/standalone-search/providers'

/** Official search provider marks in their brand colors. */
export const SearchProviderIconTile = ({ provider }: { provider: SearchProvider }) => (
  <IconTile>
    {provider === 'brave' ? (
      <SiBrave size={20} color="default" aria-hidden="true" />
    ) : (
      <img
        src={provider === 'exa' ? exaLogoSrc : tavilyLogoSrc}
        alt=""
        className={provider === 'tavily' ? 'size-5 dark:invert' : 'size-5'}
      />
    )}
  </IconTile>
)
