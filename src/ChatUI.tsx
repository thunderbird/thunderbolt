import type { UseChatHelpers } from '@ai-sdk/solid'
import { For } from 'solid-js'

interface ChatUIProps {
  chatHelpers: UseChatHelpers
}

export default function ChatUI({ chatHelpers }: ChatUIProps) {
  const { messages, input, handleInputChange, handleSubmit } = chatHelpers

  console.log('messages', messages())

  return (
    <div class="flex flex-col h-full bg-gray-50 overflow-hidden">
      <div class="flex-1 p-4 overflow-y-auto space-y-4">
        <For each={messages()}>
          {(message, i) =>
            message.role === 'assistant' ? (
              <div class="p-4 space-y-2 rounded-tl-lg rounded-tr-lg rounded-br-lg max-w-3/4 bg-white border border-gray-200 mr-auto">
                <For each={message.parts.filter((part) => part.type === 'tool-invocation')}>
                  {(part) => {
                    const { toolName, toolCallId, args } = part.toolInvocation

                    switch (toolName) {
                      case 'answer':
                        return (
                          <div class="space-y-2">
                            <div class="text-gray-700 leading-relaxed">{args.text}</div>
                          </div>
                        )
                      case 'search':
                        return (
                          <div class="space-y-2">
                            <div class="bg-blue-50 border border-blue-200 p-2 rounded-md text-gray-700 leading-relaxed italic flex items-center">Searching for "{args.query}"...</div>
                          </div>
                        )
                      default:
                        return (
                          <div class="space-y-2">
                            <div class="text-gray-700 leading-relaxed">{args.text}</div>
                          </div>
                        )
                    }
                  }}
                </For>
              </div>
            ) : (
              <div class="p-4 rounded-tl-lg rounded-tr-lg rounded-bl-lg max-w-3/4 bg-indigo-100 text-gray-800 ml-auto">
                <div class="space-y-2">
                  <div class="text-gray-700 leading-relaxed">{message.content}</div>
                </div>
              </div>
            )
          }
        </For>
      </div>

      <div class="border-t border-gray-200 p-4 bg-white">
        <form onSubmit={handleSubmit} class="flex gap-2">
          <input
            value={input()}
            onInput={handleInputChange}
            placeholder="Say something..."
            class="flex-1 px-4 py-2 border border-gray-300 rounded-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
          <button type="submit" class="bg-indigo-600 text-white px-4 py-2 rounded-full hover:bg-indigo-700 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2">
            Send
          </button>
        </form>
      </div>
    </div>
  )
}
