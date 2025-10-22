import { OnboardingAuthStepWrapper } from './wrappers/OnboardingAuthStepWrapper'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'

const meta = {
  title: 'components/onboarding/onboarding-auth-step',
  component: OnboardingAuthStepWrapper,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    onNext: { action: 'next' },
    providers: {
      control: { type: 'object' },
      description: 'Array of OAuth providers',
    },
  },
  decorators: [
    (Story) => (
      <div className="w-[400px] h-[500px] border rounded-lg p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof OnboardingAuthStepWrapper>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    onNext: fn(),
    providers: ['google'],
  },
}

export const Microsoft: Story = {
  args: {
    onNext: fn(),
    providers: ['microsoft'],
  },
}

export const MultipleProviders: Story = {
  args: {
    onNext: fn(),
    providers: ['google', 'microsoft'],
  },
}
