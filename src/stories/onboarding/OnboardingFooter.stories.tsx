/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { OnboardingActionButtons } from '@/components/onboarding/onboarding-action-buttons'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'

const meta = {
  title: 'components/onboarding/onboarding-action-buttons',
  component: OnboardingActionButtons,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    onBack: { action: 'back' },
    onSkip: { action: 'skip' },
  },
} satisfies Meta<typeof OnboardingActionButtons>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    onBack: fn(),
    onSkip: fn(),
    onContinue: fn(),
  },
}
