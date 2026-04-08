import type { HttpClient } from '@/lib/http'
import { createContext, useContext, type ReactNode } from 'react'

export type { HttpClient }

type HttpClientContextType = {
  httpClient: HttpClient
}

const HttpClientContext = createContext<HttpClientContextType | undefined>(undefined)

export const HttpClientProvider = ({ children, httpClient }: { children: ReactNode; httpClient: HttpClient }) => {
  return <HttpClientContext.Provider value={{ httpClient }}>{children}</HttpClientContext.Provider>
}

export const useHttpClient = () => {
  const context = useContext(HttpClientContext)
  if (!context) {
    throw new Error('useHttpClient must be used within an HttpClientProvider')
  }
  return context.httpClient
}
