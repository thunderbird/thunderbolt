import { getDrizzleDatabase } from '@/db/singleton'
import { settingsTable } from '@/db/tables'
import { Model, SaveMessagesFunction } from '@/types'
import { createDeepInfra } from '@ai-sdk/deepinfra'
import { createFireworks } from '@ai-sdk/fireworks'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { convertToModelMessages, extractReasoningMiddleware, LanguageModel, streamText, ToolInvocation, UIMessage, wrapLanguageModel } from 'ai'
import { eq } from 'drizzle-orm'
import { toolset } from './tools'

export type ToolInvocationWithResult<T = object> = ToolInvocation & {
  result: T
}

type PromptParams = {
  preferredName: string
  location: {
    name?: string
    lat?: number
    lng?: number
  }
}

const createPrompt = ({ preferredName, location }: PromptParams) => {
  const prompt = [
    `You are a helpful executive assistant.`,
    `The current date and time is ${new Date().toISOString()}.`,
    preferredName ? `The current's name is ${preferredName}.` : '',
    location ? `The user's location is ${location.name} (${location.lat}, ${location.lng}).` : '',
    `You can use the available tools to answer the user's question.`,
    `If you are unable to answer the user's question based on the available information, just say so. Do not make up an answer.`,
    `Respond to the user's question in a helpful, concise and friendly manner. Always reply to the user in plain text - do not reply in markdown or mention JSON or anything about tools`,
  ]

  return prompt.filter(Boolean).join('\n')
}

export const ollama = createOpenAI({
  baseURL: 'http://localhost:11434/v1',
  // compatibility: 'compatible',
  apiKey: 'ollama',
})

type AiFetchStreamingResponseOptions = {
  init: RequestInit
  saveMessages: SaveMessagesFunction
  model: Model
}

export const createModel = (modelConfig: Model): LanguageModel => {
  switch (modelConfig.provider) {
    case 'openai': {
      if (!modelConfig.apiKey) {
        throw new Error('No API key provided')
      }
      const openai = createOpenAI({
        apiKey: modelConfig.apiKey,
      })
      const model = openai(modelConfig.model)

      return model
    }
    case 'fireworks': {
      if (!modelConfig.apiKey) {
        throw new Error('No API key provided')
      }
      const fireworks = createFireworks({
        apiKey: modelConfig.apiKey,
      })

      const model = fireworks(modelConfig.model)

      return model as LanguageModel
    }
    case 'deepinfra': {
      if (!modelConfig.apiKey) {
        throw new Error('No API key provided')
      }
      const deepinfra = createDeepInfra({
        apiKey: modelConfig.apiKey,
      })

      // const model = deepinfra('meta-llama/Meta-Llama-3.1-70B-Instruct')
      const model = deepinfra(modelConfig.model)

      return model as LanguageModel
    }
    case 'openai_compatible': {
      if (!modelConfig.url) {
        throw new Error('No URL provided')
      }
      const openaiCompatible = createOpenAICompatible({
        name: 'custom',
        baseURL: modelConfig.url,
        apiKey: modelConfig.apiKey ?? undefined,
      })
      return openaiCompatible(modelConfig.model) as LanguageModel
    }
    default: {
      throw new Error(`Unsupported model provider: ${modelConfig.provider}`)
    }
  }
}

export const aiFetchStreamingResponse = async ({ init, saveMessages, model: modelConfig }: AiFetchStreamingResponseOptions) => {
  try {
    const baseModel = await createModel(modelConfig)

    const wrappedModel = wrapLanguageModel({
      model: baseModel,
      middleware: extractReasoningMiddleware({ tagName: 'think' }),
    })

    const model = wrappedModel

    const options = init as RequestInit & { body: string }
    const body = JSON.parse(options.body)

    const { messages, chatId } = body as { messages: UIMessage[]; chatId: string }

    await saveMessages({
      id: chatId,
      messages,
    })

    console.log('Using model', modelConfig.provider, modelConfig.model)

    const { db } = await getDrizzleDatabase()

    const locationNameResult = await db.select().from(settingsTable).where(eq(settingsTable.key, 'location_name')).get()
    const locationLatResult = await db.select().from(settingsTable).where(eq(settingsTable.key, 'location_lat')).get()
    const locationLngResult = await db.select().from(settingsTable).where(eq(settingsTable.key, 'location_lng')).get()
    const preferredNameResult = await db.select().from(settingsTable).where(eq(settingsTable.key, 'preferred_name')).get()

    const result = streamText({
      model,
      system: createPrompt({
        preferredName: preferredNameResult?.value as string,
        location: {
          name: locationNameResult?.value as string,
          lat: parseFloat(locationLatResult?.value as string),
          lng: parseFloat(locationLngResult?.value as string),
        },
      }),
      messages: convertToModelMessages(messages),
      toolCallStreaming: true,
      tools: toolset,
      // continueUntil: hasToolCall('answer'),
      // continueUntil: maxSteps(5),

      // toolChoice: 'required',
    })

    return result.toUIMessageStreamResponse({
      sendReasoning: true,
    })
  } catch (error) {
    console.error('Error in aiFetchStreamingResponse:', error)
    throw error
  }
}
