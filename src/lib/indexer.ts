import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { emailMessagesTable, emailThreadsTable, embeddingsTable } from '@/db/tables'
import { eq, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { threadAsText } from './as-text'
import { generateEmbeddingsCloud } from './embeddings'

export class Indexer {
  private db: AnyDrizzleDatabase
  private batchSize: number
  private isIndexing: boolean
  private shouldCancelAfterNextBatch: boolean
  private threadCount: number
  private embeddingsCount: number
  private debug: {
    slowThreadThreshold: number
    slowThreads: string[]
    totalEmbeddingTime: number
    totalEmbeddingsProcessed: number
  }

  constructor({ db, batchSize = 10 }: { db: AnyDrizzleDatabase; batchSize?: number }) {
    this.db = db
    this.batchSize = batchSize
    this.isIndexing = false
    this.shouldCancelAfterNextBatch = false
    this.threadCount = 0
    this.embeddingsCount = 0
    this.debug = {
      slowThreadThreshold: 5000,
      slowThreads: [],
      totalEmbeddingTime: 0,
      totalEmbeddingsProcessed: 0,
    }
  }

  async fetchNextBatch() {
    // Get threads that don't have embeddings yet
    const threads = await this.db
      .select()
      .from(emailThreadsTable)
      .leftJoin(embeddingsTable, eq(emailThreadsTable.id, embeddingsTable.emailThreadId))
      .where(sql`${embeddingsTable.id} IS NULL`)
      .orderBy(sql`${emailThreadsTable.lastMessageAt} DESC`)
      .limit(this.batchSize)

    // For each thread, fetch its messages
    const threadsWithMessages = await Promise.all(
      threads.map(async (thread) => {
        const messages = await this.db
          .select()
          .from(emailMessagesTable)
          .where(eq(emailMessagesTable.emailThreadId, thread.email_threads.id))
          .orderBy(sql`${emailMessagesTable.sentAt} ASC`)

        return {
          thread: thread.email_threads,
          messages,
        }
      }),
    )

    return threadsWithMessages
  }

  async embedNextBatch() {
    const threadsWithMessages = await this.fetchNextBatch()

    // Create text representation for each thread
    const texts = threadsWithMessages.map(({ thread, messages }) => {
      if (messages.length === 0) {
        return `Thread: ${thread.subject || '(No Subject)'}\n<No Messages>`
      }
      return threadAsText(thread, messages)
    })

    console.log(texts)

    const startTime = performance.now()
    const embeddings = await generateEmbeddingsCloud(texts)
    const endTime = performance.now()

    const embeddingTime = endTime - startTime
    this.debug.totalEmbeddingTime += embeddingTime
    this.debug.totalEmbeddingsProcessed += texts.length

    if (embeddingTime > this.debug.slowThreadThreshold) {
      this.debug.slowThreads.push(threadsWithMessages[0].thread.id)
    }

    return texts.map((_text, index) => ({
      embedding: embeddings[index],
      as_text: texts[index],
      email_thread_id: threadsWithMessages[index].thread.id,
    }))
  }

  async indexNextBatch() {
    const embeddings = await this.embedNextBatch()
    for (const embedding of embeddings) {
      await this.db.insert(embeddingsTable).values({
        id: uuidv7(),
        ...embedding,
      })
    }
  }

  async indexAll() {
    this.isIndexing = true
    this.shouldCancelAfterNextBatch = false

    while (true) {
      if (this.shouldCancelAfterNextBatch) {
        this.isIndexing = false
        this.shouldCancelAfterNextBatch = false
        break
      }

      await this.updateProgress()

      if (this.threadCount === this.embeddingsCount) {
        break
      }

      await this.indexNextBatch()
    }
  }

  async updateProgress() {
    try {
      const allThreads = await this.db.select().from(emailThreadsTable)
      this.threadCount = allThreads.length
    } catch (error) {
      console.warn('Could not get thread count:', error)
      this.threadCount = 0
    }

    try {
      const allEmbeddings = await this.db.select().from(embeddingsTable)
      this.embeddingsCount = allEmbeddings.length
    } catch (error) {
      console.warn('Could not get embeddings count:', error)
      this.embeddingsCount = 0
    }
  }

  cancel() {
    this.shouldCancelAfterNextBatch = true
  }

  getStatus() {
    return {
      isIndexing: this.isIndexing,
      threadCount: this.threadCount,
      embeddingsCount: this.embeddingsCount,
      shouldCancelAfterNextBatch: this.shouldCancelAfterNextBatch,
      batchSize: this.batchSize,
      debug: this.debug,
    }
  }
}
