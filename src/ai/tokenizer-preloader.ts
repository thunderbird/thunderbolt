import { preloadTokenizers } from '@/ai/tokenizer'
import { DatabaseSingleton } from '@/db/singleton'
import { Model } from '@/types'

/**
 * Preload tokenizers for all enabled models to improve performance
 * This should be called during app initialization
 */
export async function initializeTokenizers(): Promise<void> {
  try {
    console.log('Initializing tokenizers...')
    
    const db = DatabaseSingleton.instance.db
    const enabledModels = await db.query.modelsTable.findMany({
      where: (model, { eq }) => eq(model.enabled, 1)
    }) as Model[]
    
    if (enabledModels.length === 0) {
      console.log('No enabled models found, skipping tokenizer initialization')
      return
    }
    
    console.log(`Preloading tokenizers for ${enabledModels.length} enabled models...`)
    const startTime = performance.now()
    
    await preloadTokenizers(enabledModels)
    
    const endTime = performance.now()
    console.log(`Tokenizers preloaded in ${Math.round(endTime - startTime)}ms`)
    
  } catch (error) {
    console.warn('Failed to initialize tokenizers:', error)
    // Don't throw - this is a performance optimization, not critical
  }
}

/**
 * Measure tokenizer loading time for performance monitoring
 */
export async function measureTokenizerPerformance(model: Model): Promise<number> {
  const { validateTokenLimit } = await import('@/ai/tokenizer')
  
  const testMessages = [
    { role: 'user', content: 'Hello, how are you?' },
    { role: 'assistant', content: 'I am doing well, thank you for asking!' }
  ]
  const testSystemPrompt = 'You are a helpful assistant.'
  
  const startTime = performance.now()
  await validateTokenLimit(testMessages, testSystemPrompt, model)
  const endTime = performance.now()
  
  return endTime - startTime
}