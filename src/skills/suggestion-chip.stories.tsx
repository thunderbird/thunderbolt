/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Meta, StoryObj } from '@storybook/react-vite'

import { createTestProvider } from '@/test-utils/test-provider'
import { SuggestionChip } from './suggestion-chip'

const TestProvider = createTestProvider()

const meta = {
  title: 'Skills/SuggestionChip',
  component: SuggestionChip,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'Pinned-skill chip rendered above the chat input. Click inserts the `/slug` token; right-click / long-press opens the action menu (Run · Add · Add instructions · Reorder · Unpin). Run uses router-state navigation — no `?run=` URL surface (Skills v1 §5).',
      },
    },
  },
  decorators: [
    (Story) => (
      <TestProvider>
        <div className="bg-background p-8">
          <Story />
        </div>
      </TestProvider>
    ),
  ],
} satisfies Meta<typeof SuggestionChip>

export default meta
type Story = StoryObj<typeof meta>

const noop = () => {}

export const Default: Story = {
  args: {
    label: 'daily-brief',
    dimmed: false,
    onClick: noop,
    onAddInstruction: noop,
    onReorder: noop,
    onUnpin: noop,
  },
}

export const Dimmed: Story = {
  args: { ...Default.args, dimmed: true },
}

export const LongName: Story = {
  args: { ...Default.args, label: 'long-skill-name-that-truncates' },
}
