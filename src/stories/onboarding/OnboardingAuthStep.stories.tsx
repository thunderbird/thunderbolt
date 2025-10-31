import { OnboardingAuthStepWrapper } from './wrappers/OnboardingAuthStepWrapper'
import type { Meta, StoryObj } from '@storybook/react-vite'

const meta = {
  title: 'components/onboarding/onboarding-auth-step',
  component: OnboardingAuthStepWrapper,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof OnboardingAuthStepWrapper>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
