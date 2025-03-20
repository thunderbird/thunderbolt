import { emailMessagesTable, embeddingsTable } from '@/db/schema'
import { DrizzleContextType } from '@/types'
import { invoke } from '@tauri-apps/api/core'
import { eq, sql } from 'drizzle-orm'

/**
 * Generates embeddings for a batch of email messages in the database
 * @param batchSize The number of messages to process in this batch
 * @returns A promise that resolves to the number of messages processed
 */
export async function generateBatch(batchSize: number = 10): Promise<number> {
  try {
    const processedCount = await invoke('generate_batch', { batchSize })
    return processedCount as number
  } catch (error) {
    console.error('Failed to generate batch embeddings:', error)
    throw error
  }
}

/**
 * Generates embeddings for email messages in the database
 * @param batchSize The number of messages to process in each batch
 * @returns A promise that resolves when the operation is complete
 */
export async function generateEmbeddings(batchSize: number = 10): Promise<void> {
  try {
    await invoke('generate_embeddings', { batchSize })
  } catch (error) {
    console.error('Failed to generate embeddings:', error)
    throw error
  }
}

export async function getEmbedding(text: string): Promise<number[]> {
  try {
    const result = await invoke('get_embedding', { text })
    return result as number[]
  } catch (error) {
    console.error('Failed to get embedding:', error)
    throw error
  }
}
/**
 * Searches for similar email messages based on text similarity
 * @param searchText The text to search for
 * @param limit The maximum number of results to return (default: 5)
 * @returns A promise that resolves to an array of matching email messages
 */
export async function search(db: DrizzleContextType['db'], searchText: string, limit: number = 5): Promise<any[]> {
  try {
    const embedding = await getEmbedding(searchText)

    const results = await db
      .select({
        distance: sql`vector_distance_cos(${embeddingsTable.embedding}, vector32(${JSON.stringify(embedding)}))`.as('distance'),
        email_message: emailMessagesTable,
      })
      .from(sql`vector_top_k('embeddings_test_index', vector32(${JSON.stringify(embedding)}), ${limit}) as r`)
      .leftJoin(embeddingsTable, sql`${embeddingsTable}.rowid = r.id`)
      .leftJoin(emailMessagesTable, eq(emailMessagesTable.id, sql`email_message_id`))
      .orderBy(sql`distance ASC`)

    return results
  } catch (error) {
    console.error('Failed to search similar messages:', error)
    throw error
  }
}
