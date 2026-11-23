/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { ReactNode } from 'react'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { cn } from '@/lib/utils'

type AdminSectionProps = {
  title: ReactNode
  /** One muted line under the title saying what the section holds; it folds away with the rows. */
  description?: ReactNode
  /** Shown beside the title, open or collapsed: a count, say. */
  summary?: ReactNode
  /** Whether the section starts open. The choice isn't kept: each visit starts the same way. */
  defaultOpen?: boolean
  children: ReactNode
}

/**
 * A titled, collapsible group of rows on an admin list page, set apart like the sections of
 * Preferences. The title row is the toggle.
 */
export const AdminSection = ({ title, description, summary, defaultOpen = true, children }: AdminSectionProps) => (
  // The list body already spaces its children; the margin sets one section apart from the next.
  <Accordion type="single" collapsible defaultValue={defaultOpen ? 'section' : undefined} className="mt-4 first:mt-0">
    <AccordionItem value="section" className="border-b-0">
      <AccordionTrigger className="items-center py-0 hover:no-underline">
        <span className="flex items-center gap-2">
          <span className="text-lg font-semibold">{title}</span>
          {summary}
        </span>
      </AccordionTrigger>
      {/* The description sits close under the title; rows keep their usual gap. */}
      <AccordionContent className={cn('flex flex-col gap-4 pb-0', description ? 'pt-1' : 'pt-4')}>
        {description && <p className="text-[length:var(--font-size-sm)] text-muted-foreground">{description}</p>}
        {children}
      </AccordionContent>
    </AccordionItem>
  </Accordion>
)
