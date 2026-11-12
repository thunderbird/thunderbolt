/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import hindsightLogo from '@/assets/hindsight.png'
import mem0Logo from '@/assets/mem0.svg'
import supermemoryLogo from '@/assets/supermemory.svg'
import zepLogo from '@/assets/zep.svg'
import { cn } from '@/lib/utils'
import type { MemoryMcpProviderId } from '@/memory/providers'

const providerLogos = {
  supermemory: supermemoryLogo,
  mem0: mem0Logo,
  hindsight: hindsightLogo,
  zep: zepLogo,
} satisfies Record<MemoryMcpProviderId, string>

/** Official local provider marks; decorative beside the visible connection name. */
export const MemoryProviderLogo = ({ provider, className }: { provider: MemoryMcpProviderId; className?: string }) => (
  <span aria-hidden="true" className={cn('inline-flex size-6 shrink-0 items-center justify-center', className)}>
    <img
      src={providerLogos[provider]}
      alt=""
      className={cn('size-full object-contain', provider === 'supermemory' && 'dark:invert')}
    />
  </span>
)
