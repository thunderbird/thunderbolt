/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DeleteChatDialog, type DeleteChatDialogRef } from '@/components/delete-chat-dialog'
import { Button } from '@/components/ui/button'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useRef, useEffect } from 'react'

import { fn } from 'storybook/test'

// More on how to set up stories at: https://storybook.js.org/docs/writing-stories#default-export
const meta = {
  title: 'components/delete-chat-dialog',
  component: DeleteChatDialog,
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
  args: { onCancel: fn(), onConfirm: fn() },
} satisfies Meta<typeof DeleteChatDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {
  render: ({ onConfirm, onCancel, ...args }) => {
    const ref = useRef<DeleteChatDialogRef>(null)

    const handleConfirm = () => {
      onConfirm()
      ref.current?.close()
    }

    const handleCancel = () => {
      onCancel?.()
      ref.current?.close()
    }

    // Auto-open the dialog when component mounts
    useEffect(() => {
      ref.current?.open()
    }, [])

    return <DeleteChatDialog ref={ref} onConfirm={handleConfirm} onCancel={handleCancel} {...args} />
  },
}

export const Basic: Story = {
  render: ({ onConfirm, ...args }) => {
    const ref = useRef<DeleteChatDialogRef>(null)

    const handleConfirm = () => {
      onConfirm()
      ref.current?.close()
    }

    return (
      <>
        <Button onClick={() => ref.current?.open()}>Open Delete Chat Dialog</Button>
        <DeleteChatDialog ref={ref} onConfirm={handleConfirm} {...args} />
      </>
    )
  },
}
