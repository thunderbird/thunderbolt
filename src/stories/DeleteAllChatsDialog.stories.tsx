import { DeleteAllChatsDialog, DeleteAllChatsDialogRef } from '@/components/delete-all-chats-dialog'
import { Button } from '@/components/ui/button'
import type { Meta, StoryObj } from '@storybook/react-vite'
import React, { useRef } from 'react'

import { fn } from 'storybook/test'

// More on how to set up stories at: https://storybook.js.org/docs/writing-stories#default-export
const meta = {
  title: 'components/delete-all-chats-dialog',
  component: DeleteAllChatsDialog,
  parameters: {
    layout: 'centered',
    docs: {
      story: {
        inline: false,
        iframeHeight: 400,
      },
    },
  },
  tags: ['autodocs'],
  argTypes: {},
  args: { onConfirm: fn() },
} satisfies Meta<typeof DeleteAllChatsDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {
  render: ({ onConfirm, ...args }) => {
    const ref = useRef<DeleteAllChatsDialogRef>(null)

    const handleConfirm = () => {
      onConfirm()
      ref.current?.close()
    }

    // Auto-open the dialog when component mounts
    React.useEffect(() => {
      ref.current?.open()
    }, [])

    return <DeleteAllChatsDialog ref={ref} onConfirm={handleConfirm} {...args} />
  },
}

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
