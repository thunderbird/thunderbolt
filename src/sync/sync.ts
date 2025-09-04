import type { ImapCredentials } from '@/imap/imap'
import { invoke } from '@tauri-apps/api/core'

/**
 * **ImapSyncClient**
 *
 * The `ImapSyncClient` class serves as the primary interface for
 * synchronizing IMAP messages with the local database.
 */
export default class ImapSyncClient {
  /**
   * **initialize**
   *
   * Initializes the IMAP sync client. The IMAP client and database must be initialized first.
   *
   * @example
   * ```ts
   * await ImapSyncClient.initialize();
   * ```
   */
  async initialize({ hostname, port, username, password }: ImapCredentials): Promise<void> {
    await invoke<void>('init_imap_sync', { hostname, port, username, password })
  }

  /**
   * **syncMailbox**
   *
   * Synchronizes messages from a mailbox with the local database.
   *
   * @param mailbox - The mailbox to sync (defaults to "INBOX")
   * @param pageSize - The number of messages to fetch per page
   * @param since - Optional RFC3339 date string to only sync messages since that date
   *
   * @example
   * ```ts
   * // Sync the INBOX mailbox with default settings
   * const count = await ImapSyncClient.syncMailbox("INBOX", 10);
   *
   * // Sync messages since a specific date
   * const count = await ImapSyncClient.syncMailbox("INBOX", 10, "2023-01-01T00:00:00Z");
   * ```
   */
  async syncMailbox(mailbox: string = 'INBOX', pageSize: number = 10, since?: string): Promise<number> {
    return await invoke<number>('sync_mailbox', { mailbox, pageSize, since })
  }
}
