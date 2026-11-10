/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { ChatAddMenu } from '@/components/chat/chat-add-menu'
import { PromptInput } from '@/components/ui/prompt-input'
import { AgentExecutionControls } from './agent-execution-controls'

const ComposerPreview = (props: { threadId: string; disabled: boolean }) => {
  const [value, setValue] = useState('')
  return (
    <div className="w-full max-w-2xl p-4">
      <PromptInput
        value={value}
        onChange={setValue}
        isLoading={props.disabled}
        className="flex w-full flex-col gap-0 rounded-3xl bg-sidebar p-2"
        footerStartElements={
          <>
            <ChatAddMenu onOpenConnections={() => {}} />
            <AgentExecutionControls {...props} />
          </>
        }
      />
    </div>
  )
}

const meta = {
  title: 'Chat/AgentExecutionControls',
  component: AgentExecutionControls,
  parameters: { layout: 'padded' },
  args: { threadId: 'execution-preview', disabled: false },
  render: (args) => <ComposerPreview {...args} />,
} satisfies Meta<typeof AgentExecutionControls>
export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
export const Running: Story = { args: { disabled: true } }
