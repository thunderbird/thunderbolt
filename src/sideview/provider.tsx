'use client'

import type { SideviewType } from '@/types'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

interface SideviewContextType {
  sideviewType: SideviewType | null
  sideviewId: string | null
  setSideview: (sideviewType: SideviewType | null, sideviewId: string | null) => void
}

const SideviewContext = createContext<SideviewContextType | undefined>(undefined)

interface SideviewProviderProps {
  children: ReactNode
  sideviewType?: SideviewType | null
  sideviewId?: string | null
}

export function SideviewProvider({
  children,
  sideviewType: initialSideviewType = null,
  sideviewId: initialSideviewId = null,
}: SideviewProviderProps) {
  const [sideviewType, setSideviewType] = useState<SideviewType | null>(initialSideviewType)
  const [sideviewId, setSideviewId] = useState<string | null>(initialSideviewId)
  const setSideview = (type: SideviewType | null, id: string | null) => {
    setSideviewType(type)
    setSideviewId(id)
  }

  useEffect(() => {
    const url = new URL(window.location.href)

    if (sideviewType && sideviewId) {
      url.searchParams.set('sideview', `${sideviewType}:${encodeURIComponent(sideviewId)}`)
    } else {
      url.searchParams.delete('sideview')
    }

    window.history.pushState(null, '', url.toString())
  }, [sideviewType, sideviewId])

  return (
    <SideviewContext.Provider
      value={{
        sideviewType,
        sideviewId,
        setSideview,
      }}
    >
      {children}
    </SideviewContext.Provider>
  )
}

export function useSideview() {
  const context = useContext(SideviewContext)
  if (context === undefined) {
    throw new Error('useSideview must be used within a SideviewProvider')
  }
  return context
}
