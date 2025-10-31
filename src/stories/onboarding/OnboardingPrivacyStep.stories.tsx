import { OnboardingPrivacyStepWrapper } from './wrappers/OnboardingPrivacyStepWrapper'
import type { Meta, StoryObj } from '@storybook/react-vite'

const meta = {
  title: 'components/onboarding/onboarding-privacy-step',
  component: OnboardingPrivacyStepWrapper,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof OnboardingPrivacyStepWrapper>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
