/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { OnboardingNameStepWrapper } from './wrappers/OnboardingNameStepWrapper'
import type { Meta, StoryObj } from '@storybook/react-vite'

const meta = {
  title: 'components/onboarding/onboarding-name-step',
  component: OnboardingNameStepWrapper,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof OnboardingNameStepWrapper>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
