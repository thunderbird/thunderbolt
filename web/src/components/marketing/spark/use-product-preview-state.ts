/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState } from 'react'

const platforms = ['Desktop', 'Mobile', 'Terminal'] as const

/** Selects which client appears in the product preview. */
export const useProductPreviewState = () => {
  const [platform, setPlatform] = useState<(typeof platforms)[number]>('Desktop')
  return { platform, setPlatform, platforms }
}
