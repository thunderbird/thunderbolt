/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Input } from '@/components/ui/input'
import type { Meta, StoryObj } from '@storybook/react-vite'

import { fn } from 'storybook/test'

// More on how to set up stories at: https://storybook.js.org/docs/writing-stories#default-export
const meta = {
  title: 'components/ui/input',
  component: Input,
  parameters: {
    // Optional parameter to center the component in the Canvas. More info: https://storybook.js.org/docs/configure/story-layout
    layout: 'centered',
  },
  // This component will have an automatically generated Autodocs entry: https://storybook.js.org/docs/writing-docs/autodocs
  tags: ['autodocs'],
  // More on argTypes: https://storybook.js.org/docs/api/argtypes
  argTypes: {
    variant: {
      table: {
        defaultValue: { summary: 'default' },
      },
      options: ['default', 'filled', 'outline', 'ghost'],
      control: { type: 'radio' },
    },
    inputSize: {
      table: {
        defaultValue: { summary: 'default' },
      },
      options: ['default', 'sm', 'lg', 'xl'],
      control: { type: 'radio' },
    },
    state: {
      table: {
        defaultValue: { summary: 'default' },
      },
      options: ['default', 'error', 'success'],
      control: { type: 'radio' },
    },
  },
  // Use `fn` to spy on the onClick arg, which will appear in the actions panel once invoked: https://storybook.js.org/docs/essentials/actions#action-args
  args: { onClick: fn(), variant: 'default' },
} satisfies Meta<typeof Input>

export default meta
type Story = StoryObj<typeof meta>

// More on writing stories with args: https://storybook.js.org/docs/writing-stories/args
export const Basic: Story = {
  args: {
    placeholder: 'Type here...',
    variant: 'default',
    inputSize: 'default',
  },
}
