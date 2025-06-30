import type { ToolConfig } from '@/types'
import type { ChatOptions, FlowerIntelligence, StreamEvent } from '@flwr/flwr'
import { convertToModelMessages, type UIMessage } from 'ai'
import ky from 'ky'
import { getCloudUrl } from './config'
import { memoize } from './memoize'
import { createFlowerToolset, createToolset } from './tools'

export async function getFlowerApiKey(): Promise<string | undefined> {
  const cloudUrl = await getCloudUrl()
  const response = await ky.post(`${cloudUrl}/flower/api-key`, {
    json: {},
  })

  const data = await response.json<{ api_key: string }>()
  return data.api_key
}

const getFlowerIntelligenceDebug = async (): Promise<FlowerIntelligence> => {
  // @ts-ignore - Module may not exist in CI environment
  const { FlowerIntelligence } = await import('../../flower/intelligence/ts/src/index')
  return FlowerIntelligence.instance as unknown as FlowerIntelligence
}

const getFlowerIntelligenceRelease = async (): Promise<FlowerIntelligence> => {
  const moduleUrl = '/flower/intelligence/ts/dist/flowerintelligence.bundled.es.js'
  const { FlowerIntelligence } = await (eval(`import("${moduleUrl}")`) as Promise<any>)
  return FlowerIntelligence.instance
}

export const getFlowerIntelligence = memoize(async () => {
  const flowerApiKey = await getFlowerApiKey()
  if (!flowerApiKey) {
    throw new Error('Failed to get Flower API key')
  }

  const fi =
    process.env.NODE_ENV === 'development' ? await getFlowerIntelligenceDebug() : await getFlowerIntelligenceRelease()

  fi.apiKey = flowerApiKey
  fi.remoteHandoff = true

  const cloudUrl = await getCloudUrl()

  // baseUrl exists in the custom branch of the Flower Intelligence SDK but not in the official version.
  // We're using the official TypeScript types, so we need to ignore the type error.

  // @ts-ignore-next-line
  fi.baseUrl = `${cloudUrl}/flower`
  return fi
})

export const handleFlowerChatStream = async ({
  model,
  systemPrompt,
  messages,
  tools,
}: {
  model: ChatOptions['model']
  systemPrompt: string
  messages: UIMessage[]
  tools?: ToolConfig[]
}) => {
  // Convert UI messages to Flower format using the same function as other providers
  const modelMessages = convertToModelMessages(messages, {
    tools: tools ? createToolset(tools) : undefined,
  })

  const flowerMessages = modelMessages.map((msg) => {
    let content: string

    if (typeof msg.content === 'string') {
      content = msg.content
    } else if (Array.isArray(msg.content)) {
      // Extract text from structured content
      content = msg.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
    } else {
      content = JSON.stringify(msg.content)
    }

    return {
      role: msg.role as 'user' | 'assistant' | 'system',
      content,
    }
  })

  const hasSystemMessage = flowerMessages.some((msg) => msg.role === 'system')
  if (!hasSystemMessage) {
    flowerMessages.unshift({
      role: 'system',
      content: systemPrompt,
    })
  }

  // Create a custom streaming response that mimics Vercel AI SDK format
  return new Response(
    new ReadableStream({
      async start(controller) {
        try {
          let fullResponse = ''

          const fi = await getFlowerIntelligence()
          const toolset = tools ? createFlowerToolset(tools) : undefined

          await fi.chat({
            messages: flowerMessages,
            model,
            stream: true,
            tools: toolset,
            onStreamEvent: (event: StreamEvent) => {
              if (event.chunk) {
                fullResponse += event.chunk

                // Format as proper SSE data event
                controller.enqueue(
                  new TextEncoder().encode(`data: ${JSON.stringify({ type: 'text', text: event.chunk })}\n\n`),
                )
              }
            },
            forceRemote: true,
          })

          // Send finish event in SSE format
          controller.enqueue(
            new TextEncoder().encode(`data: ${JSON.stringify({ type: 'finish', finishReason: 'stop' })}\n\n`),
          )

          // Send final DONE event
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))

          controller.close()
        } catch (error) {
          console.error('Error in Flower streaming:', error)

          // Send error event in SSE format
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : 'Unknown error' })}\n\n`,
            ),
          )

          controller.close()
        }
      },
    }),
    {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    },
  )
}
