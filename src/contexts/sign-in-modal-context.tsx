'use client'

import { createContext, useContext, useState, type ReactNode } from 'react'

import { SignInModal } from '@/components/sign-in-modal'

type SignInModalContextValue = {
  openSignInModal: () => void
}

const SignInModalContext = createContext<SignInModalContextValue | null>(null)

export const useSignInModal = () => {
  const context = useContext(SignInModalContext)
  if (!context) {
    throw new Error('useSignInModal must be used within SignInModalProvider')
  }
  return context
}

type SignInModalProviderProps = {
  children: ReactNode
}

export const SignInModalProvider = ({ children }: SignInModalProviderProps) => {
  const [open, setOpen] = useState(false)

  const openSignInModal = () => setOpen(true)

  return (
    <SignInModalContext.Provider value={{ openSignInModal }}>
      {children}
      <SignInModal open={open} onOpenChange={setOpen} />
    </SignInModalContext.Provider>
  )
}
