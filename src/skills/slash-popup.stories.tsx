/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Meta, StoryObj } from '@storybook/react-vite'

import { createTestProvider } from '@/test-utils/test-provider'
import type { Skill } from '@/types'
import { SlashPopup } from './slash-popup'
import type { SlashItem } from './use-slash-command'

const TestProvider = createTestProvider()

const meta = {
  title: 'Skills/SlashPopup',
  component: SlashPopup,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          "Autocomplete list shown above the chat input when the user types `/`. Filters the user's enabled skills alphabetically by the in-progress slug — no recency or popularity ranking per Skills v1 §4.",
      },
    },
  },
  decorators: [
    (Story) => (
      <TestProvider>
        <div className="relative h-[420px] w-[640px] bg-background p-6">
          <div className="absolute bottom-6 left-6 right-6 h-12 rounded-lg border border-border bg-card" />
          <Story />
        </div>
      </TestProvider>
    ),
  ],
} satisfies Meta<typeof SlashPopup>

export default meta
type Story = StoryObj<typeof meta>

const skillItem = (id: string, name: string, description: string): SlashItem => ({
  kind: 'skill',
  id,
  name,
  description,
  skill: {
    id,
    name,
    description,
    instruction: '',
    enabled: 1,
    pinnedOrder: null,
    deletedAt: null,
    defaultHash: null,
    userId: null,
    workspaceId: null,
    scope: null,
  } as Skill,
})

const sampleItems: SlashItem[] = [
  skillItem('1', 'daily-brief', 'Weather, news, inbox, and calendar in one digest.'),
  skillItem('2', 'important-emails', 'Triage the inbox and surface the most important emails.'),
  // An external command advertised by the connected ACP agent.
  {
    kind: 'command',
    id: 'command:research_codebase',
    name: 'research_codebase',
    description: 'Have the agent explore and summarize the codebase.',
  },
]

const noop = () => undefined

export const Default: Story = {
  args: {
    items: sampleItems,
    agentName: 'Hermes',
    highlightedIdx: 0,
    onSelect: noop,
    onHover: noop,
  },
}

export const SecondRowHighlighted: Story = {
  args: { ...Default.args, highlightedIdx: 1 },
}

export const SingleResult: Story = {
  args: { ...Default.args, items: [sampleItems[0]!], highlightedIdx: 0 },
}
