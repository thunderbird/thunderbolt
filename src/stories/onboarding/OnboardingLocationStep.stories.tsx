import { OnboardingLocationStepWrapper } from './wrappers/OnboardingLocationStepWrapper'
import type { Meta, StoryObj } from '@storybook/react-vite'

const meta = {
  title: 'components/onboarding/onboarding-location-step',
  component: OnboardingLocationStepWrapper,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof OnboardingLocationStepWrapper>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
