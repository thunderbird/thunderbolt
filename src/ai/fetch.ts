import { createPrompt } from '@/ai/prompt'
import { DatabaseSingleton } from '@/db/singleton'
import { modelsTable } from '@/db/tables'
import { getCloudUrl } from '@/lib/config'
import { getSetting } from '@/lib/dal'
import { fetch } from '@/lib/fetch'
import { handleFlowerChatStream } from '@/lib/flower'
import { createToolset, getAvailableTools } from '@/lib/tools'
import { Model, SaveMessagesFunction } from '@/types'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

// Currently @openrouter/ai-sdk-provider is NOT compatible with Vercel AI SDK v5. If you enable this, you will get the following error:
// > [Error] Chat error: – Error: Unhandled chunk type: text-start — run-tools-transformation.ts:275
// OpenRouter is working on a new version of their SDK that is compatible with Vercel AI SDK v5. We'll uncomment this when it's ready.
// import { createOpenRouter } from '@openrouter/ai-sdk-provider'

import {
  convertToModelMessages,
  experimental_createMCPClient,
  LanguageModel,
  streamText,
  ToolInvocation,
  UIMessage,
  wrapLanguageModel,
  type ToolSet,
} from 'ai'
import { eq } from 'drizzle-orm'
import { defaultMiddleware } from './middleware/default'

export type ToolInvocationWithResult<T = object> = ToolInvocation & {
  result: T
}

export type MCPClient = Awaited<ReturnType<typeof experimental_createMCPClient>>

export const ollama = createOpenAI({
  baseURL: 'http://localhost:11434/v1',
  // compatibility: 'compatible',
  apiKey: 'ollama',
  fetch,
})

type AiFetchStreamingResponseOptions = {
  init: RequestInit
  saveMessages: SaveMessagesFunction
  modelId: string
  mcpClients?: MCPClient[]
}

export const createModel = async (modelConfig: Model): Promise<LanguageModel> => {
  switch (modelConfig.provider) {
    case 'thunderbolt': {
      const cloudUrl = await getCloudUrl()
      const openaiCompatible = createOpenAICompatible({
        name: 'thunderbolt',
        baseURL: `${cloudUrl}/openai`,
        fetch,
      })
      return openaiCompatible(modelConfig.model)
    }
    case 'openai': {
      if (!modelConfig.apiKey) throw new Error('No API key provided')
      const openai = createOpenAI({
        apiKey: modelConfig.apiKey,
        fetch,
      })
      return openai(modelConfig.model)
    }
    case 'custom': {
      if (!modelConfig.url) throw new Error('No URL provided for custom provider')
      const openaiCompatible = createOpenAICompatible({
        name: 'custom',
        baseURL: modelConfig.url,
        apiKey: modelConfig.apiKey || undefined,
        fetch,
      })
      return openaiCompatible(modelConfig.model)
    }
    case 'openrouter': {
      if (!modelConfig.apiKey) throw new Error('No API key provided')
      // Using OpenAI-compatible approach until @openrouter/ai-sdk-provider supports Vercel AI SDK v5
      // https://github.com/OpenRouterTeam/ai-sdk-provider/pull/77
      const openrouter = createOpenAICompatible({
        name: 'openrouter',
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: modelConfig.apiKey,
        fetch,
      })
      return openrouter(modelConfig.model)
    }
    default:
      throw new Error(`Unsupported provider: ${modelConfig.provider}`)
  }
}

export const aiFetchStreamingResponse = async ({
  init,
  saveMessages,
  modelId,
  mcpClients,
}: AiFetchStreamingResponseOptions) => {
  const options = init as RequestInit & { body: string }
  const body = JSON.parse(options.body)
  const abortSignal: AbortSignal | undefined = options.signal ?? undefined

  const { messages, chatId } = body as { messages: UIMessage[]; chatId: string }

  await saveMessages({ id: chatId, messages })

  const db = DatabaseSingleton.instance.db

  const locationName = await getSetting<string>('location_name')
  const locationLat = await getSetting<string>('location_lat')
  const locationLng = await getSetting<string>('location_lng')
  const preferredName = await getSetting<string>('preferred_name')

  const model = await db.query.modelsTable.findFirst({
    where: eq(modelsTable.id, modelId),
  })

  if (!model) throw new Error('Model not found')

  const supportsTools = model.toolUsage !== 0

  let toolset: ToolSet = {}
  if (supportsTools) {
    const availableTools = await getAvailableTools()
    toolset = { ...createToolset(availableTools) }

    for (const mcpClient of mcpClients || []) {
      const mcpTools = await mcpClient.tools()
      Object.assign(toolset, mcpTools)
    }
  } else {
    console.log('Model does not support tools, skipping tool setup')
  }

  const systemPrompt = createPrompt({
    preferredName: preferredName as string,
    location: {
      name: locationName as string,
      lat: locationLat ? parseFloat(locationLat as string) : undefined,
      lng: locationLng ? parseFloat(locationLng as string) : undefined,
    },
  })

  // Flower is a special case that uses a custom SDK that is not compatible with the Vercel AI SDK.
  if (model.provider === 'flower') {
    const tools = model.toolUsage === 1 ? await getAvailableTools() : undefined
    return handleFlowerChatStream({ messages, systemPrompt, model: model.model, tools })
  }

  try {
    const baseModel = await createModel(model)

    const wrappedModel = wrapLanguageModel({
      providerId: model.provider,
      model: baseModel,
      middleware: defaultMiddleware,
    })

    const result = streamText({
      temperature: 0.25,
      model: wrappedModel,
      system: systemPrompt,
      messages: convertToModelMessages(messages),
      toolCallStreaming: supportsTools,
      tools: supportsTools ? toolset : undefined,
      maxSteps: 10,
      abortSignal,
      // providerOptions: {
      //   custom: {
      //     // reasoningEffort: 'low',
      //   } satisfies OpenAICompatibleProviderOptions,
      // },
      onStepFinish: (step) => {
        console.log('step', {
          text: step.text,
          finishReason: step.finishReason,
          toolCallCount: step.toolCalls?.length || 0,
        })
      },
      onFinish: (finish) => {
        console.log('finish', {
          text: finish.text,
          finishReason: finish.finishReason,
          toolCallCount: finish.toolCalls?.length || 0,
        })
      },
      onError: (error) => {
        console.error('error', error)
      },
      onChunk: (chunk) => {
        console.log('chunk', chunk)
      },
    })

    return result.toUIMessageStreamResponse({
      sendReasoning: true,
      // Attach the modelId as metadata so the client knows which model was used
      messageMetadata: () => ({ modelId }),
    })
  } catch (error) {
    console.error('aiFetchStreamingResponse error', error)
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
