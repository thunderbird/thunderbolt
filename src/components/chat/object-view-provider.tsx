import { createContext, useContext, useState } from 'react'
import { useSidebar } from '../ui/sidebar'
import { ObjectSidebar } from './object-sidebar'

interface ObjectViewContextType {
  objectContent: any
  openObjectSidebar: (content: any) => void
  closeObjectSidebar: () => void
}

const ObjectViewContext = createContext<ObjectViewContextType | undefined>(undefined)

interface ObjectViewProviderProps {
  children: React.ReactNode
}

export function ObjectViewProvider({ children }: ObjectViewProviderProps) {
  const [objectContent, setObjectContent] = useState<any>()
  const { isMobile, setOpenMobile, setOpen } = useSidebar()

  const openObjectSidebar = (content: any) => {
    setObjectContent(content)
    isMobile ? setOpenMobile(true) : setOpen(true)
  }

  const closeObjectSidebar = () => {
    isMobile ? setOpenMobile(false) : setOpen(false)
  }

  return (
    <ObjectViewContext.Provider
      value={{
        objectContent,
        openObjectSidebar,
        closeObjectSidebar,
      }}
    >
      {children}
      <ObjectSidebar />
    </ObjectViewContext.Provider>
  )
}

export function useObjectView() {
  const context = useContext(ObjectViewContext)
  if (context === undefined) {
    throw new Error('useObjectView must be used within an ObjectViewProvider')
  }
  return context
}
