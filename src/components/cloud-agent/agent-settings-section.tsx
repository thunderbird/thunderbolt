/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { AccordionItem, AccordionTrigger, AccordionContent } from '@/components/ui/accordion'
import { useFormatters } from '@/i18n/use-formatters'

/** Shared accordion presentation for choosing an agent's capabilities during creation and editing. */
export const AgentSettingsSection = ({
  value,
  title,
  icon,
  count,
  children,
}: {
  value: string
  title: string
  icon: ReactNode
  count: number
  children: ReactNode
}) => {
  const { t } = useLingui()
  const formatters = useFormatters()
  return (
    <AccordionItem value={value}>
      <AccordionTrigger className="cursor-pointer items-center py-3 hover:no-underline">
        <span className="flex items-center gap-2.5">
          <span aria-hidden="true" className="text-muted-foreground [&>svg]:size-4">
            {icon}
          </span>
          {title}
        </span>
        <span className="ml-auto text-xs font-normal text-muted-foreground">
          {count ? t`${formatters.number(count)} selected` : <Trans>None</Trans>}
        </span>
      </AccordionTrigger>
      <AccordionContent className="flex flex-col gap-3 pb-3">{children}</AccordionContent>
    </AccordionItem>
  )
}
