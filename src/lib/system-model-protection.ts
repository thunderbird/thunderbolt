import { getModelById } from './dal'

export const checkSystemModelProtection = async (modelId: string, operation: string): Promise<void> => {
  const model = await getModelById(modelId)

  if (model?.isSystem) {
    throw new Error(`Cannot ${operation} system models`)
  }
}
