import { createContext, useContext, useState } from 'react'
import { SidebarInset, useSidebar } from '../ui/sidebar'
import { ObjectSidebar } from './object-sidebar'

type ObjectContent = {
  title: string
  content: string
}

interface ObjectViewContextType {
  objectContent: ObjectContent | null
  openObjectSidebar: (content: ObjectContent) => void
  closeObjectSidebar: () => void
}

const ObjectViewContext = createContext<ObjectViewContextType | undefined>(undefined)

interface ObjectViewProviderProps {
  children: React.ReactNode
}

export function ObjectViewProvider({ children }: ObjectViewProviderProps) {
  const [objectContent, setObjectContent] = useState<ObjectContent | null>(null)
  const { isMobile, setOpenMobile, setOpen } = useSidebar()

  const openObjectSidebar = (content: ObjectContent) => {
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
      <SidebarInset>{children}</SidebarInset>
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
