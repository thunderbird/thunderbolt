/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Meta, StoryObj } from '@storybook/react-vite'

import { SuggestionChip } from './suggestion-chip'

const meta = {
  title: 'Skills/SuggestionChip',
  component: SuggestionChip,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'Pinned-skill chip rendered above the chat input. Click inserts the `/slug` token; right-click / long-press opens the action menu (Add to chat · Add instructions to chat · Edit skill · Reorder · Unpin).',
      },
    },
  },
  decorators: [
    (Story) => (
      <div className="bg-background p-8">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SuggestionChip>

export default meta
type Story = StoryObj<typeof meta>

const noop = () => {}

export const Default: Story = {
  args: {
    label: 'Daily Brief',
    onClick: noop,
    onAddInstruction: noop,
    onEdit: noop,
    onReorder: noop,
    onUnpin: noop,
  },
}

export const LongName: Story = {
  args: { ...Default.args, label: 'Long Skill Name That Truncates' },
}
