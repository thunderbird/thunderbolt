import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { emailMessagesTable, emailThreadsTable, embeddingsTable } from '@/db/tables'
import { invoke } from '@tauri-apps/api/core'
import { eq, isNotNull, sql } from 'drizzle-orm'

/**
 * Initializes the embedder model in the backend
 * @returns A promise that resolves when the embedder is initialized
 */
export async function initEmbedder(): Promise<void> {
  try {
    await invoke('init_embedder')
  } catch (error) {
    console.error('Failed to initialize embedder:', error)
    throw error
  }
}

/**
 * Generates embeddings for email messages in the database
 * @param texts The texts to generate embeddings for
 * @returns A promise that resolves with the generated embeddings
 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  try {
    return await invoke('generate_embeddings', { texts })
  } catch (error) {
    console.error('Failed to generate embeddings:', error)
    throw error
  }
}

/**
 * Generates embeddings for email messages in the database using Hugging Face API
 * @param texts The texts to generate embeddings for
 * @returns A promise that resolves with the generated embeddings
 */
export async function generateEmbeddingsCloud(texts: string[]): Promise<number[][]> {
  try {
    const response = await fetch(
      'https://router.huggingface.co/hf-inference/pipeline/feature-extraction/intfloat/e5-small-v2',
      {
        headers: {
          Authorization: 'Bearer LOL_OOPS',
          'Content-Type': 'application/json',
        },
        method: 'POST',
        body: JSON.stringify({
          inputs: texts,
        }),
      },
    )

    const embeddings = await response.json()
    return embeddings
  } catch (error) {
    console.error('Failed to generate embeddings from Hugging Face:', error)
    throw error
  }
}

/**
 * Searches for similar email messages based on text similarity
 * @param searchText The text to search for
 * @param limit The maximum number of results to return (default: 5)
 * @returns A promise that resolves to an array of matching email threads with their messages
 */
export async function search(db: AnyDrizzleDatabase, searchText: string, limit: number = 5) {
  try {
    const [embedding] = await generateEmbeddings([searchText])

    // This is done via migration but I'm putting it here just in case we reset the migrations.
    const indexCreationResult = await db.run(sql`
      CREATE INDEX IF NOT EXISTS embeddings_index ON embeddings (libsql_vector_idx(embedding));
    `)
    console.log('Index Created (If Not Exists):', indexCreationResult)

    // Get the top matching threads based on embedding similarity with aggregated messages
    const results = await db
      .select({
        distance: sql`vector_distance_cos(${embeddingsTable.embedding}, vector32(${JSON.stringify(embedding)}))`.as(
          'distance',
        ),
        email_thread_id: emailThreadsTable.id,
        email_thread: emailThreadsTable,
        as_text: embeddingsTable.asText,
      })
      .from(sql`vector_top_k('embeddings_index', vector32(${JSON.stringify(embedding)}), ${limit}) as r`)
      .leftJoin(embeddingsTable, sql`${embeddingsTable}.rowid = r.id`)
      .leftJoin(emailThreadsTable, eq(emailThreadsTable.id, embeddingsTable.emailThreadId))
      .where(isNotNull(embeddingsTable.emailThreadId))
      .groupBy(emailThreadsTable.id)
      .orderBy(sql`distance ASC`)

    // Fetch messages for each thread
    const resultsWithMessages = await Promise.all(
      results.map(async (result) => {
        const email_messages = await db
          .select()
          .from(emailMessagesTable)
          .where(eq(emailMessagesTable.emailThreadId, result.email_thread_id!))
          .orderBy(emailMessagesTable.sentAt)

        return {
          ...result,
          email_messages,
        }
      }),
    )

    console.log('Results:', resultsWithMessages)
    return resultsWithMessages
  } catch (error) {
    console.error('Failed to search similar messages:', error)
    throw error
  }
}
