/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { SidebarContent } from '@/components/ui/sidebar'
import { ContentViewHeader } from './header'
import { type ObjectViewData } from './context'

type ObjectSidebarContentProps = {
  content: ObjectViewData
  onClose: () => void
}

/**
 * Content for displaying tool call results in the unified content view
 */
export const ObjectSidebarContent = ({ content, onClose }: ObjectSidebarContentProps) => {
  return (
    <div
      className="flex h-dvh flex-col md:pt-[var(--safe-area-top-padding)]"
      style={{
        paddingBottom: 'var(--safe-area-bottom-padding)',
      }}
    >
      <ContentViewHeader title={content.title} onClose={onClose} className="md:bg-card" />
      <SidebarContent className="p-4 overflow-x-hidden">
        {content.input && (
          <>
            <h3 className="text-muted-foreground text-[length:var(--font-size-xs)] font-medium">
              <Trans>Input</Trans>
            </h3>
            <p data-testid="object-view-input" className="text-foreground mb-4 text-sm break-words whitespace-pre-wrap">
              {content.input}
            </p>
            <h3 className="text-muted-foreground text-[length:var(--font-size-xs)] font-medium">
              <Trans>Result</Trans>
            </h3>
          </>
        )}
        <p data-testid="object-view-output" className="text-foreground text-sm break-words whitespace-pre-wrap">
          {content.output}
        </p>
      </SidebarContent>
    </div>
  )
}
