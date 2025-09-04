import { camelCasedPropertiesDeep } from '@/lib/utils'
import type { ImapEmailMessage } from '@/types'
import { invoke } from '@tauri-apps/api/core'
import type { SnakeCasedPropertiesDeep } from 'type-fest'

export type ImapEmailAddress = {
  name: string
  address: string
}

/**
 * Interface for IMAP credentials
 */
export interface ImapCredentials {
  hostname: string
  port: number
  username: string
  password: string
}

/**
 * **ImapClient**
 *
 * The `ImapClient` class serves as the primary interface for
 * communicating with the rust side of the IMAP functionality.
 */
export default class ImapClient {
  private _isInitialized: boolean = false

  /**
   * **isInitialized**
   *
   * Returns whether the IMAP client has been initialized.
   */
  get isInitialized(): boolean {
    return this._isInitialized
  }

  /**
   * **initialize**
   *
   * Initializes the IMAP client with the provided credentials.
   *
   * @example
   * ```ts
   * await ImapClient.initialize({
   *   hostname: 'imap.example.com',
   *   port: 993,
   *   username: 'user@example.com',
   *   password: 'password'
   * });
   * ```
   */
  async initialize(credentials: ImapCredentials): Promise<void> {
    await invoke<void>('init_imap', { ...credentials })
    this._isInitialized = true
  }

  /**
   * **listMailboxes**
   *
   * Lists all available mailboxes from the IMAP server.
   *
   * @example
   * ```ts
   * const mailboxes = await ImapClient.listMailboxes();
   * ```
   */
  async listMailboxes(): Promise<Record<string, any>> {
    return await invoke<Record<string, any>>('list_mailboxes')
  }

  /**
   * **fetchMessages**
   *
   * Fetches messages from a specific mailbox.
   *
   * @param mailbox - The mailbox to fetch messages from
   * @param startIndex - Optional starting index for fetching messages
   * @param count - Optional number of messages to fetch
   * @returns An object containing the messages, current index, and total message count
   *
   * @example
   * ```ts
   * const result = await ImapClient.fetchMessages("INBOX", 1, 10);
   * console.log(`Fetched ${result.messages.length} of ${result.total} messages`);
   * ```
   */
  async fetchMessages(
    mailbox: string,
    startIndex?: number,
    count?: number,
  ): Promise<{
    index: number
    total: number
    messages: ImapEmailMessage[]
  }> {
    const result = await invoke<{
      index: number
      total: number
      messages: SnakeCasedPropertiesDeep<ImapEmailMessage>[]
    }>('fetch_messages', { mailbox, startIndex, count })

    const camelCasedResult = camelCasedPropertiesDeep(result)
    return camelCasedResult
  }
}
