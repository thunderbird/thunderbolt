/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Meta, StoryObj } from '@storybook/react-vite'

import { createTestProvider } from '@/test-utils/test-provider'
import type { Skill } from '@/types'
import { SlashPopup } from './slash-popup'

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

const sampleSkills: Skill[] = [
  {
    id: '1',
    name: 'meeting-notes',
    description: 'Summarize a meeting transcript into action items and decisions.',
    instruction: '',
    enabled: 1,
    pinnedOrder: 0,
    deletedAt: null,
    defaultHash: null,
    userId: null,
  },
  {
    id: '2',
    name: 'task-triage',
    description: 'Sort a dump of tasks into priority buckets.',
    instruction: '',
    enabled: 1,
    pinnedOrder: 1,
    deletedAt: null,
    defaultHash: null,
    userId: null,
  },
  {
    id: '3',
    name: 'weekly-review',
    description: 'Reflect on the week. Wins, losses, next steps.',
    instruction: '',
    enabled: 1,
    pinnedOrder: 2,
    deletedAt: null,
    defaultHash: null,
    userId: null,
  },
]

const noop = () => undefined
const noPins = () => false

export const Default: Story = {
  args: {
    skills: sampleSkills,
    highlightedIdx: 0,
    isPinned: noPins,
    pinCapReached: false,
    onSelect: noop,
    onHover: noop,
    onTogglePin: noop,
  },
}

export const SecondRowHighlighted: Story = {
  args: { ...Default.args, highlightedIdx: 1 },
}

export const SingleResult: Story = {
  args: { ...Default.args, skills: [sampleSkills[0]!], highlightedIdx: 0 },
}

export const SomePinned: Story = {
  args: { ...Default.args, isPinned: (id: string) => id === '1' || id === '3' },
}

export const PinCapReached: Story = {
  args: { ...Default.args, isPinned: (id: string) => id === '1', pinCapReached: true },
}
