/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { HttpClient } from '@/lib/http'
import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react'

export type { HttpClient }

type HttpClientContextType = {
  httpClient: HttpClient
}

const HttpClientContext = createContext<HttpClientContextType | undefined>(undefined)

/** Keep clients captured by chat sessions pointed at the currently selected server. */
export const HttpClientProvider = ({ children, httpClient }: { children: ReactNode; httpClient: HttpClient }) => {
  const clientRef = useRef(httpClient)
  clientRef.current = httpClient
  const value = useMemo<HttpClientContextType>(
    () => ({
      httpClient: {
        get: (url, options) => clientRef.current.get(url, options),
        post: (url, options) => clientRef.current.post(url, options),
        delete: (url, options) => clientRef.current.delete(url, options),
      },
    }),
    [],
  )
  return <HttpClientContext.Provider value={value}>{children}</HttpClientContext.Provider>
}

export const useHttpClient = () => {
  const context = useContext(HttpClientContext)
  if (!context) {
    throw new Error('useHttpClient must be used within an HttpClientProvider')
  }
  return context.httpClient
}
