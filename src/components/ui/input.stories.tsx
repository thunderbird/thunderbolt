/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Meta, StoryObj } from '@storybook/react-vite'

import { Input } from './input'

const meta = {
  title: 'UI/Input',
  component: Input,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'Text input. Light mode is a transparent field with a border; dark mode adds a faint translucent fill (`--color-input`) so the field lifts off any surface.',
      },
    },
  },
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
  argTypes: {
    variant: {
      options: ['default', 'filled', 'outline', 'ghost'],
      control: { type: 'radio' },
    },
    inputSize: {
      options: ['default', 'sm', 'lg', 'xl'],
      control: { type: 'radio' },
    },
    state: {
      options: ['default', 'error', 'success'],
      control: { type: 'radio' },
    },
  },
  args: {
    placeholder: 'Type something...',
  },
} satisfies Meta<typeof Input>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Variants: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <Input placeholder="Default" />
      <Input variant="filled" placeholder="Filled" />
      <Input variant="outline" placeholder="Outline" />
      <Input variant="ghost" placeholder="Ghost" />
    </div>
  ),
}

export const Sizes: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <Input inputSize="sm" placeholder="Small" />
      <Input inputSize="default" placeholder="Default" />
      <Input inputSize="lg" placeholder="Large" />
      <Input inputSize="xl" placeholder="Extra large" />
    </div>
  ),
}

export const ErrorState: Story = {
  args: { state: 'error', defaultValue: 'invalid-slug!' },
}

export const Disabled: Story = {
  args: { disabled: true, defaultValue: 'Read only' },
}
