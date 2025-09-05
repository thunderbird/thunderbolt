export { createFlowerProvider } from './flower'
export type {
  FlowerChatArgs,
  FlowerClient,
  FlowerMessage,
  FlowerProviderOptions,
  FlowerUsage,
  FlowerStreamEvent,
} from './flower'

// Define FlowerTool type based on the actual structure from @flwr/flwr
export type FlowerTool = {
  type: string
  function: {
    name: string
    description: string
    parameters: {
      type: string
      properties: Record<
        string,
        {
          type: string
          description: string
          enum?: string[]
        }
      >
      required: string[]
    }
  }
}
