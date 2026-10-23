/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Meta, StoryObj } from '@storybook/react-vite'
import type { CompactionCheckpoint } from '@shared/agent-core'
import { ContextUsageIndicator } from '@/components/context-usage'
import { ContentViewProvider, useContentView } from '@/content-view/context'
import { ActiveContentView } from '@/content-view/active-content-view'

const checkpoint: CompactionCheckpoint = {
  version: 1,
  summary:
    '## Goal\nPlan a weekend in Barcelona.\n\n## Preferences\n- Stay near the Gothic Quarter.\n- Prioritize local restaurants and architecture.\n- Keep the itinerary relaxed.\n\n## Decisions\nVisit the Sagrada Família on Saturday morning and explore Montjuïc on Sunday.\n\n## Next steps\nChoose restaurants within walking distance of the hotel.',
  tokensBefore: 84_000,
  contextTokens: 12_000,
  retainedTail: [{ role: 'user', timestamp: 1, content: 'Keep the restaurant recommendations walkable.' }],
}

const SummaryPreview = () => {
  const { isOpen, showCompactionSummary } = useContentView()
  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <main className="flex min-w-0 flex-1 flex-col justify-end p-6">
        <div className="rounded-3xl border p-3">
          <p className="mb-4 text-muted-foreground">Ask me anything…</p>
          <ContextUsageIndicator
            usedTokens={12_000}
            maxTokens={131_000}
            onCompact={async () => {}}
            onViewSummary={() => showCompactionSummary(checkpoint)}
          />
        </div>
      </main>
      {isOpen && (
        <aside className="w-1/2 border-l bg-card">
          <ActiveContentView />
        </aside>
      )}
    </div>
  )
}

const meta = {
  title: 'Components/CompactionSummary',
  component: SummaryPreview,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <ContentViewProvider>
        <Story />
      </ContentViewProvider>
    ),
  ],
} satisfies Meta<typeof SummaryPreview>

export default meta
type Story = StoryObj<typeof meta>

export const Sidebar: Story = {}
