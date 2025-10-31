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
