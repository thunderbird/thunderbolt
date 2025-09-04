import { createContext, useContext, type ReactNode, type FC } from 'react'
import type ImapSyncClient from './sync'

type ImapSyncContextType = {
  client: ImapSyncClient
}

const ImapSyncContext = createContext<ImapSyncContextType | undefined>(undefined)

export const useImapSync = (): ImapSyncClient => {
  const context = useContext(ImapSyncContext)
  if (!context) {
    throw new Error('useImapSync must be used within an ImapSyncProvider')
  }
  return context.client
}

type ImapSyncProviderProps = {
  client: ImapSyncClient
  children: ReactNode
}

export const ImapSyncProvider: FC<ImapSyncProviderProps> = ({ client, children }) => {
  return <ImapSyncContext.Provider value={{ client }}>{children}</ImapSyncContext.Provider>
}
