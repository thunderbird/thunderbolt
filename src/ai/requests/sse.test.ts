import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModelV2StreamPart } from '@ai-sdk/provider'
import { extractReasoningMiddleware, simulateReadableStream, streamText, wrapLanguageModel } from 'ai'
import { MockLanguageModelV2 } from 'ai/test'
import { describe, it } from 'bun:test'
import fs from 'fs'
import { join } from 'path'

describe.skip('sse', async () => {
  it('should return a readable stream', async () => {
    const result = streamText({
      model: new MockLanguageModelV2({
        doStream: async () => ({
          stream: simulateReadableStream<LanguageModelV2StreamPart>({
            initialDelayInMs: 1000, // Delay before the first chunk
            chunkDelayInMs: 300, // Delay between chunks
            chunks: [
              {
                type: 'reasoning',
                text: "\nOkay, the user said \"hi\". I need to respond appropriately. Since they didn't ask a question or request anything specific, I should greet them back and offer assistance. Let me check if there's any tool I need to use here. They didn't mention anything that requires a tool, so a simple response should suffice. I'll make sure to keep it friendly and open-ended.\n\nMaybe add an emoji to keep it approachable. Let me structure it with a subheader and some bullet points for clarity. Wait, the user might be looking for help with something, so I should prompt them to ask questions. Also, remember to ask for their location if they need location-based help. But since they haven't asked for anything like that yet, maybe just a general offer to assist. Alright, let's put it all together.\n",
              },
              {
                type: 'text',
                text: "Hello! 👋 How can I assist you today? Whether you have questions, need help with planning, or just want to chat, I'm here for you! Let me know how I can be helpful. 🌟  \n\n**Need help with:**  \n- Finding information?  \n- Scheduling or reminders?  \n- General advice or ideas?  \n\nJust ask! 😊",
              },
              {
                type: 'finish',
                finishReason: 'stop',
                usage: {
                  inputTokens: 10,
                  outputTokens: 10,
                  totalTokens: 20,
                },
              },
            ],
          }), // .pipeThrough(new TextEncoderStream()),
        }),
      }),
      prompt: 'Hello, test!',
    })

    for await (const chunk of result.fullStream) {
      console.log('chunk', chunk)
    }

    // await result.consumeStream()
    // console.log('result.content', await result.steps)
  })
})

const chunks = fs
  .readFileSync(join(__dirname, 'tests/apple/stream.sse'), 'utf8')
  .split('\n')
  .map((line) => line.split('data: ')[1])
  .filter(Boolean)
  .filter((line) => line !== '[DONE]')
  .map((line) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      console.log('cannot parse', line)
      process.exit(1)
    }
  })
  .map((chunk) => {
    // console.log('chunk', chunk)
    return chunk
  })

const provider = createOpenAICompatible({
  baseURL: 'http://localhost:3000',
  fetch: async () => {
    return new Response(
      simulateReadableStream({
        // initialDelayInMs: 1000, // Delay before the first chunk
        // chunkDelayInMs: 300, // Delay between chunks
        chunks: [
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":"<think>\\n"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":"Okay, the user is"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" asking for the weather forecast this"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" week. Let me check what"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" I need"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" to do.\\n\\nFirst, I"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" remember that the user doesn"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":"'t provided their location yet."},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" The instructions say I should ask"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" for the location before using any"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" location-based tools. Since"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" the weather"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" forecast depends on the"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" location, I can't"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" proceed without that information."},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" \\n\\nI should"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" respond by asking them where"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" they are located."},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" That way, once they"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" provide the city or"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" area, I can use"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" the appropriate tool to get the"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" forecast. I need"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" to make sure I don't"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" mention any tools by name"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":", just ask for the"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" location. \\n\\nAlso,"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" I need to follow the"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" format: use Markdown,"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" sub"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":"headers, bullet points, and"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" emojis if appropriate"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":". Let me structure the response"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" politely and clearly"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":". Make sure to explain why"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" I need the location so they"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" understand it's necessary for the"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" forecast. \\n\\nDouble-check"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":"ing the guidelines:"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" don't invent info"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":", be honest if I can"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":"'t help without the"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" location."},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" Yep, that's covered"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":". Alright, time to put"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" it all together.\\n"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":"</think>\\n\\n🌤️"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" **Weekly Weather Forecast Request**"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":"  \\n\\nTo provide you with the"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" most accurate forecast,"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" I need to know your **"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":"location** (e.g.,"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" city or region). Weather varies"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" by area, and"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" real-time data requires this"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" detail to"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" proceed."},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":"  \\n\\nCould you share where you"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":"'re located? Once I have"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" that, I'll fetch the"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" latest forecast for you!"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" 🌍✨"},"finish_reason":null}],"usage":null}\n\n`,
          `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":317,"total_tokens":611,"completion_tokens":294}}\n\n`,
          `data: [DONE]\n\n`,
        ],
      }).pipeThrough(new TextEncoderStream()),
      {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
        },
      },
    )
  },
})

const model = provider('test-model')

const wrappedModel = wrapLanguageModel({
  model,
  middleware: [extractReasoningMiddleware({ tagName: 'think' })],
})

describe('sse', async () => {
  it('should return a readable stream', async () => {
    const result = streamText({
      model: wrappedModel,
      prompt: 'Hello, test!',
    })

    for await (const chunk of result.fullStream) {
      // console.log('chunk2', chunk)
    }

    for await (const step of await result.steps) {
      console.log('step', step)
    }
  })
})
