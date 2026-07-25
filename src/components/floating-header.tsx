/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Header } from '@/components/ui/header'
import { Scrim } from '@/components/ui/scrim'

/**
 * The floating app header plus its top scrim, shared by the main and settings
 * layouts. Must render inside a `relative` container.
 *
 * The scrim fades the page background from the very top of the viewport down
 * past the floating header, so content scrolling beneath stays legible behind
 * the header controls.
 *
 * The header floats over the content instead of consuming layout height —
 * pages own the full viewport and pad by `--header-inset` where needed.
 */
export const FloatingHeader = () => (
  <>
    <Scrim className="z-20" height="calc(var(--header-inset) + 2.5rem)" />
    <div className="absolute inset-x-0 top-0 z-30" style={{ paddingTop: 'var(--safe-area-top-padding)' }}>
      <Header />
    </div>
  </>
)
