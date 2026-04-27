/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ContextUsageIndicator } from '@/components/context-usage-indicator'
import type { Meta, StoryObj } from '@storybook/react-vite'

const meta = {
  title: 'components/context-usage-indicator',
  component: ContextUsageIndicator,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    usedTokens: {
      control: { type: 'number', min: 0, max: 300000 },
      description: 'Number of tokens currently used',
    },
    maxTokens: {
      control: { type: 'number', min: 1000, max: 300000 },
      description: 'Maximum number of tokens available',
    },
  },
} satisfies Meta<typeof ContextUsageIndicator>

export default meta
type Story = StoryObj<typeof meta>

export const SmallUsage: Story = {
  args: {
    usedTokens: 42,
    maxTokens: 4096,
  },
  name: '1% Usage',
}

export const Normal: Story = {
  args: {
    usedTokens: 128000,
    maxTokens: 256000,
  },
  name: '50% Usage',
}

export const NearLimit: Story = {
  args: {
    usedTokens: 220000,
    maxTokens: 256000,
  },
  name: '86% Usage',
}

export const OverLimit: Story = {
  args: {
    usedTokens: 281600,
    maxTokens: 256000,
  },
  name: '110% Usage (Over Limit)',
}
