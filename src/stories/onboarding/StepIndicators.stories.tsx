import { StepIndicators } from '@/components/onboarding/step-indicators'
import type { Meta, StoryObj } from '@storybook/react-vite'

const meta = {
  title: 'components/onboarding/step-indicators',
  component: StepIndicators,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    currentStep: {
      control: { type: 'number', min: 1, max: 5 },
      description: 'Current step number (1-based)',
    },
    totalSteps: {
      control: { type: 'number', min: 1, max: 10 },
      description: 'Total number of steps',
    },
  },
} satisfies Meta<typeof StepIndicators>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    currentStep: 1,
    totalSteps: 5,
  },
}

export const Step2: Story = {
  args: {
    currentStep: 2,
    totalSteps: 5,
  },
}

export const Step3: Story = {
  args: {
    currentStep: 3,
    totalSteps: 5,
  },
}

export const Step4: Story = {
  args: {
    currentStep: 4,
    totalSteps: 5,
  },
}

export const Step5: Story = {
  args: {
    currentStep: 5,
    totalSteps: 5,
  },
}

export const ManySteps: Story = {
  args: {
    currentStep: 3,
    totalSteps: 8,
  },
}
