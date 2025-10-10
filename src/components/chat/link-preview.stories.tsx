import { LinkPreview } from '@/components/chat/link-preview'
import type { Meta, StoryObj } from '@storybook/react-vite'

const meta = {
  title: 'components/chat/link-preview',
  component: LinkPreview,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'A tool group component that displays multiple tool calls together with optional loading indicator for the next action.',
      },
    },
  },
  decorators: [
    (Story) => (
      <div className="p-8 bg-background max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LinkPreview>

export default meta
type Story = StoryObj<typeof meta>

export const Basic: Story = {
  args: {
    description:
      'Depending on what kind of floors you have and the debris you encounter, having the right vacuum for the job is crucial to keeping your space clean.',
    image: 'https://i.rtings.com/assets/pages/8GqYQ8Iz/best-vaccums-202108-medium.jpg?format=auto',
    title: 'The 6 Best Vacuum Cleaners of 2025',
    url: 'https://www.rtings.com/vacuum/reviews/best/vacuum-cleaners',
  },
}
