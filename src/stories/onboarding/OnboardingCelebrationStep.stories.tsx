import { OnboardingCelebrationStepWrapper } from './wrappers/OnboardingCelebrationStepWrapper'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'

const meta = {
  title: 'components/onboarding/onboarding-celebration-step',
  component: OnboardingCelebrationStepWrapper,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    onComplete: { action: 'complete' },
  },
  decorators: [
    (Story) => (
      <div className="w-[400px] h-[500px] border rounded-lg p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof OnboardingCelebrationStepWrapper>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    onComplete: fn(),
  },
}
