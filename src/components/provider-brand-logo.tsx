/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import openRouterGrape from '@/assets/openrouter-grape.svg'
import openRouterVolt from '@/assets/openrouter-volt.svg'
import tinfoilGreen from '@/assets/tinfoil-green.svg'
import { cn } from '@/lib/utils'

/** Color provider marks for settings lists and detail panels. */
export const ProviderBrandLogo = ({
  provider,
  className,
}: {
  provider: 'openrouter' | 'tinfoil'
  className?: string
}) => (
  <span aria-hidden="true" className={cn('inline-flex size-6 shrink-0 items-center justify-center', className)}>
    {provider === 'tinfoil' ? (
      <img src={tinfoilGreen} alt="" className="size-full object-contain dark:brightness-[2.5]" />
    ) : (
      <>
        <img src={openRouterGrape} alt="" className="size-full object-contain dark:hidden" />
        <img src={openRouterVolt} alt="" className="hidden size-full object-contain dark:block" />
      </>
    )}
  </span>
)
