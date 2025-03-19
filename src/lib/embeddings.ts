import { invoke } from '@tauri-apps/api/core'

/**
 * Generates embeddings for email messages in the database
 * @param batchSize The number of messages to process in each batch
 * @returns A promise that resolves when the operation is complete
 */
export async function generateEmbeddings(batchSize: number = 100): Promise<void> {
  try {
    await invoke('generate_embeddings', { batchSize })
  } catch (error) {
    console.error('Failed to generate embeddings:', error)
    throw error
  }
}
