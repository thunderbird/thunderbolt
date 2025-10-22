import { OnboardingNameStepWrapper } from './wrappers/OnboardingNameStepWrapper'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'

const meta = {
  title: 'components/onboarding/onboarding-name-step',
  component: OnboardingNameStepWrapper,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    onNext: { action: 'next' },
  },
  decorators: [
    (Story) => (
      <div className="w-[400px] h-[500px] border rounded-lg p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof OnboardingNameStepWrapper>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    onNext: fn(),
  },
}
