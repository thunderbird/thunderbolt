import type { UseChatHelpers } from '@ai-sdk/react'
import { ArrowUp, Mic, Plus } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Button } from '../ui/button'
import { AgentToolResponse } from './agent-tool-response'

interface ChatUIProps {
  chatHelpers: UseChatHelpers
}

export default function ChatUI({ chatHelpers }: ChatUIProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [chatHelpers.messages])

  return (
    <div className="flex flex-col h-full bg-white overflow-hidden max-w-[760px] mx-auto">
      <div className="flex-1 p-4 overflow-y-auto space-y-4">
        {chatHelpers.messages.map((message, i) => {
          if (message.role === 'assistant') {
            return (
              <div key={i} className="space-y-2 p-4 rounded-md  bg-secondary mr-auto">
                {message.content && <div className="text-secondary-foreground leading-relaxed">{message.content}</div>}
                {message.parts
                  ?.filter((part) => part.type === 'tool-invocation')
                  .map((part, j) => (
                    <AgentToolResponse key={j} part={part} />
                  ))}
              </div>
            )
          } else if (message.role === 'user') {
            return (
              <div key={i} className="p-4 rounded-md max-w-3/4 bg-primary text-primary-foreground ml-auto">
                <div className="space-y-2">
                  <div className="text-primary-foreground leading-relaxed">{message.content}</div>
                </div>
              </div>
            )
          }
          return null
        })}
        <div ref={messagesEndRef} />
      </div>

      <div className=" p-4">
        <form onSubmit={chatHelpers.handleSubmit} className="flex flex-col gap-2 bg-secondary p-4 rounded-md">
          <input autoFocus value={chatHelpers.input} onChange={chatHelpers.handleInputChange} placeholder="Say something..." className="flex-1 px-4 py-2   " />
          <div className="flex gap-2 justify-between">
            <div className="flex gap-2">
              <Button variant="outline" className={`h-8 w-8 rounded-full p-0 flex items-center justify-center`}>
                <Plus className="size-4" />
              </Button>
              <Button variant="outline" className={`h-8 w-8 rounded-full p-0 flex items-center justify-center`}>
                <Mic className="size-4" />
              </Button>
            </div>
            <Button type="submit" variant="default" className="h-8 w-8 rounded-full p-0 flex items-center justify-center">
              <ArrowUp className="size-4" />
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
