import { OnboardingPrivacyStepWrapper } from './wrappers/OnboardingPrivacyStepWrapper'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'

const meta = {
  title: 'components/onboarding/onboarding-privacy-step',
  component: OnboardingPrivacyStepWrapper,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    onNext: { action: 'next' },
  },
} satisfies Meta<typeof OnboardingPrivacyStepWrapper>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    onNext: fn(),
  },
}
