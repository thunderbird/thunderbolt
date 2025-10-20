import { OnboardingLocationStepWrapper } from './wrappers/OnboardingLocationStepWrapper'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'

const meta = {
  title: 'components/onboarding/onboarding-location-step',
  component: OnboardingLocationStepWrapper,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    onNext: { action: 'next' },
    onSkip: { action: 'skip' },
    onBack: { action: 'back' },
  },
  decorators: [
    (Story) => (
      <div className="w-[400px] h-[500px] border rounded-lg p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof OnboardingLocationStepWrapper>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    onNext: fn(),
    onSkip: fn(),
    onBack: fn(),
  },
}
