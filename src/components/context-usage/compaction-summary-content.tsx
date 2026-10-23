/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import type { CompactionCheckpoint } from '@shared/agent-core'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { SidebarContent } from '@/components/ui/sidebar'
import { ContentViewHeader } from '@/content-view/header'
import { MemoizedMarkdown } from '@/components/chat/memoized-markdown'
import { RetainedContextMessage } from './retained-context-message'

type CompactionSummaryContentProps = {
  checkpoint: CompactionCheckpoint
  onClose: () => void
}

export const CompactionSummaryContent = ({ checkpoint, onClose }: CompactionSummaryContentProps) => {
  const { t } = useLingui()
  return (
    <section
      aria-label={t`Compaction summary`}
      className="flex h-dvh min-w-0 flex-col md:pt-[var(--safe-area-top-padding)]"
      style={{ paddingBottom: 'var(--safe-area-bottom-padding)' }}
    >
      <ContentViewHeader title={t`Compaction summary`} onClose={onClose} className="md:bg-card" />
      <SidebarContent className="gap-4 overflow-x-hidden p-4 break-words">
        <MemoizedMarkdown id="compaction-summary" content={checkpoint.summary} />
        {checkpoint.retainedTail.length > 0 && (
          <Accordion type="single" collapsible>
            <AccordionItem value="retained-context">
              <AccordionTrigger>
                <Trans>Retained messages and tool results</Trans>
              </AccordionTrigger>
              <AccordionContent className="space-y-3">
                {checkpoint.retainedTail.map((message, index) => (
                  <RetainedContextMessage key={index} message={message} />
                ))}
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        )}
      </SidebarContent>
    </section>
  )
}
