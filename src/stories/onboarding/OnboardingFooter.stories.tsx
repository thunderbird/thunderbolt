import { OnboardingFooter } from '@/components/onboarding/onboarding-footer'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'

const meta = {
  title: 'components/onboarding/onboarding-footer',
  component: OnboardingFooter,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    onBack: { action: 'back' },
    onSkip: { action: 'skip' },
    onContinue: { action: 'continue' },
    continueText: {
      control: { type: 'text' },
      description: 'Text for the continue button',
    },
    continueDisabled: {
      control: { type: 'boolean' },
      description: 'Whether the continue button is disabled',
    },
    showBack: {
      control: { type: 'boolean' },
      description: 'Whether to show the back button',
    },
    showSkip: {
      control: { type: 'boolean' },
      description: 'Whether to show the skip button',
    },
  },
} satisfies Meta<typeof OnboardingFooter>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    onBack: fn(),
    onSkip: fn(),
    onContinue: fn(),
    continueText: 'Continue',
    continueDisabled: false,
    showBack: true,
    showSkip: true,
  },
}

export const NoBackButton: Story = {
  args: {
    onSkip: fn(),
    onContinue: fn(),
    continueText: 'I Agree & Continue',
    continueDisabled: false,
    showBack: false,
    showSkip: true,
  },
}

export const NoSkipButton: Story = {
  args: {
    onBack: fn(),
    onContinue: fn(),
    continueText: 'Complete Setup',
    continueDisabled: false,
    showBack: true,
    showSkip: false,
  },
}

export const NoBackOrSkip: Story = {
  args: {
    onContinue: fn(),
    continueText: 'Start Using Thunderbolt',
    continueDisabled: false,
    showBack: false,
    showSkip: false,
  },
}

export const DisabledContinue: Story = {
  args: {
    onBack: fn(),
    onSkip: fn(),
    onContinue: fn(),
    continueText: 'Saving...',
    continueDisabled: true,
    showBack: true,
    showSkip: true,
  },
}

export const CustomText: Story = {
  args: {
    onBack: fn(),
    onSkip: fn(),
    onContinue: fn(),
    continueText: 'Connect Google Account',
    continueDisabled: false,
    showBack: true,
    showSkip: true,
  },
}
