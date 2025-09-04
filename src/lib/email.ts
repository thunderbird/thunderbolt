import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { emailMessagesTable, emailThreadsTable } from '@/db/tables'
import type { EmailMessage, EmailThread } from '@/types'
import { eq, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

/**
 * Extract references from email parts
 * @param email The email message to extract references from
 * @returns An array of reference message IDs
 */
function extractReferences(email: EmailMessage): string[] {
  const [part] = email.parts?.parts ?? []
  const headers = part.headers
  const references =
    headers?.find((header) => header.name === 'references' && header.value && header.value.TextList)?.value?.TextList ??
    []
  return references
}

/**
 * EmailThreader class for managing email threads
 * Groups emails into threads based on in-reply-to headers
 */
export class EmailThreader {
  private db: AnyDrizzleDatabase
  private batchSize: number
  private shouldCancelAfterNextBatch: boolean
  private threadsCreated: number
  private messagesProcessed: number

  /**
   * Creates a new EmailThreader instance
   * @param db Database connection
   * @param batchSize Number of emails to process in each batch (default: 10)
   */
  constructor(db: AnyDrizzleDatabase, batchSize: number = 10) {
    this.db = db
    this.batchSize = batchSize
    this.shouldCancelAfterNextBatch = false
    this.threadsCreated = 0
    this.messagesProcessed = 0
  }

  /**
   * Cancels the email processing after the current batch completes
   */
  cancel(): void {
    this.shouldCancelAfterNextBatch = true
  }

  /**
   * Get the current processing status
   * @returns An object containing the current processing status
   */
  getStatus(): { threadsCreated: number; messagesProcessed: number; isProcessing: boolean } {
    return {
      threadsCreated: this.threadsCreated,
      messagesProcessed: this.messagesProcessed,
      isProcessing: !this.shouldCancelAfterNextBatch,
    }
  }

  /**
   * Process emails and organize them into threads
   * @returns A promise that resolves when all emails are processed
   */
  async processEmails(): Promise<void> {
    try {
      while (true) {
        // Get a batch of emails that haven't been assigned to a thread yet
        const unprocessedEmails = await this.db
          .select()
          .from(emailMessagesTable)
          .where(sql`${emailMessagesTable.emailThreadId} IS NULL`)
          .limit(this.batchSize)

        // If no more emails to process, break the loop
        if (unprocessedEmails.length === 0) {
          break
        }

        // Process each email in the batch
        for (const email of unprocessedEmails) {
          await this.processEmail(email)
          this.messagesProcessed++
        }

        // Check if we should stop after this batch
        if (this.shouldCancelAfterNextBatch) {
          break
        }
      }
    } catch (error) {
      console.error('Failed to process emails:', error)
      throw error
    }
  }

  /**
   * Process a single email and assign it to a thread
   * @param email The email message to process
   * @returns A promise that resolves when the email is processed
   */
  private async processEmail(email: EmailMessage): Promise<void> {
    try {
      // Extract references from the email parts
      const [rootImapId] = extractReferences(email)

      // If we don't have a root email message id, create a new thread
      if (!rootImapId) {
        await this.createThread(email, email.imapId)
        return
      }

      const thread = await this.db
        .select()
        .from(emailThreadsTable)
        .where(eq(emailThreadsTable.rootImapId, rootImapId))
        .limit(1)
        .get()

      if (!thread) {
        await this.createThread(email, rootImapId)
        return
      }

      await this.addEmailToThread(email, thread)
    } catch (error) {
      console.error(`Failed to process email ${email.id}:`, error)
      throw error
    }
  }

  /**
   * Create a new email thread
   * @param email Email message
   * @param rootImapId The imap id of the root email message
   * @returns A promise that resolves when the thread is created
   */
  private async createThread(email: EmailMessage, rootImapId: string): Promise<string> {
    const id = uuidv7()

    await this.db.insert(emailThreadsTable).values({
      id,
      subject: email.subject || '(No Subject)',
      firstMessageAt: email.sentAt,
      lastMessageAt: email.sentAt,
      rootImapId,
    })

    this.threadsCreated++

    return id
  }

  /**
   * Add an email to a thread
   * @param email Email message
   * @param threadId Thread ID
   * @returns A promise that resolves when the email is added to the thread
   */
  private async addEmailToThread(email: EmailMessage, thread: EmailThread): Promise<void> {
    // Update the email to be part of the thread
    await this.db
      .update(emailMessagesTable)
      .set({ emailThreadId: thread.id })
      .where(eq(emailMessagesTable.id, email.id))

    // If this email is older, update the thread subject and firstMessageAt
    if (email.sentAt < thread.firstMessageAt) {
      await this.db
        .update(emailThreadsTable)
        .set({
          subject: email.subject || thread.subject || '(No Subject)',
          firstMessageAt: email.sentAt,
        })
        .where(eq(emailThreadsTable.id, thread.id))
    }

    // If this email is newer, update the lastMessageAt
    if (email.sentAt > thread.lastMessageAt) {
      await this.db
        .update(emailThreadsTable)
        .set({
          lastMessageAt: email.sentAt,
        })
        .where(eq(emailThreadsTable.id, thread.id))
    }
  }
}
