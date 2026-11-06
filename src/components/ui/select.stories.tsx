/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Meta, StoryObj } from '@storybook/react-vite'

import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from './select'

const meta = {
  title: 'UI/Select',
  component: Select,
  parameters: {
    layout: 'centered',
  },
} satisfies Meta<typeof Select>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Select>
      <SelectTrigger className="w-56">
        <SelectValue placeholder="Pick a model" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Anthropic</SelectLabel>
          <SelectItem value="claude-sonnet">Claude Sonnet</SelectItem>
          <SelectItem value="claude-haiku">Claude Haiku</SelectItem>
        </SelectGroup>
        <SelectGroup>
          <SelectLabel>OpenAI</SelectLabel>
          <SelectItem value="gpt-5">GPT-5</SelectItem>
          <SelectItem value="gpt-5-mini">GPT-5 mini</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  ),
}

export const Preselected: Story = {
  render: () => (
    <Select defaultValue="claude-sonnet">
      <SelectTrigger className="w-56">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="claude-sonnet">Claude Sonnet</SelectItem>
        <SelectItem value="gpt-5">GPT-5</SelectItem>
      </SelectContent>
    </Select>
  ),
}

export const Disabled: Story = {
  render: () => (
    <Select disabled defaultValue="claude-sonnet">
      <SelectTrigger className="w-56">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="claude-sonnet">Claude Sonnet</SelectItem>
      </SelectContent>
    </Select>
  ),
}
