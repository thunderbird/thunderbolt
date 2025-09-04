import { createContext, useContext, type ReactNode } from 'react'
import type ImapClient from './imap'

/**
 * Interface for IMAP context
 */
export interface ImapContextType {
  client: ImapClient
}

const ImapContext = createContext<ImapContextType | undefined>(undefined)

/**
 * **ImapProvider**
 *
 * Provider component for IMAP functionality.
 * Makes the IMAP client available to all child components.
 *
 * @example
 * ```tsx
 * <ImapProvider>
 *   <YourApp />
 * </ImapProvider>
 * ```
 */
export function ImapProvider({ children, client }: { children: ReactNode; client: ImapClient }) {
  return <ImapContext.Provider value={{ client }}>{children}</ImapContext.Provider>
}

/**
 * **useImap**
 *
 * Hook to access the IMAP client from any component within the ImapProvider.
 *
 * @example
 * ```tsx
 * const { client } = useImap();
 *
 * // Now you can use the client
 * const fetchEmails = async () => {
 *   await client.initialize(credentials);
 *   const messages = await client.fetchInbox(10);
 * };
 * ```
 */
export function useImap() {
  const context = useContext(ImapContext)

  if (!context) {
    throw new Error('useImap must be used within an ImapProvider')
  }

  return context
}
