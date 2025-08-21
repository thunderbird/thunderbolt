import { DeleteAllChatsDialog, DeleteAllChatsDialogRef } from '@/components/delete-all-chats-dialog'
import { Button } from '@/components/ui/button'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useRef } from 'react'

import { fn } from 'storybook/test'

// More on how to set up stories at: https://storybook.js.org/docs/writing-stories#default-export
const meta = {
  title: 'components/delete-all-chats-dialog',
  component: DeleteAllChatsDialog,
  parameters: {
    // Optional parameter to center the component in the Canvas. More info: https://storybook.js.org/docs/configure/story-layout
    layout: 'centered',
  },
  // This component will have an automatically generated Autodocs entry: https://storybook.js.org/docs/writing-docs/autodocs
  tags: ['autodocs'],
  // More on argTypes: https://storybook.js.org/docs/api/argtypes
  argTypes: {},
  // Use `fn` to spy on the onClick arg, which will appear in the actions panel once invoked: https://storybook.js.org/docs/essentials/actions#action-args
  args: { onConfirm: fn(() => alert('Deleted')) },
} satisfies Meta<typeof DeleteAllChatsDialog>

export default meta
type Story = StoryObj<typeof meta>

// More on writing stories with args: https://storybook.js.org/docs/writing-stories/args
export const Basic: Story = {
  render: ({ onConfirm, ...args }) => {
    const ref = useRef<DeleteAllChatsDialogRef>(null)

    const handleConfirm = () => {
      onConfirm()
      ref.current?.close()
    }

    return (
      <>
        <Button onClick={() => ref.current?.open()}>Open Delete All Chats Dialog</Button>
        <DeleteAllChatsDialog ref={ref} onConfirm={handleConfirm} {...args} />
      </>
    )
  },
}
