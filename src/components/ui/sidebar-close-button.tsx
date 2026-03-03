import { X } from 'lucide-react'
import { type ComponentProps } from 'react'
import { Button } from './button'

export const SidebarCloseButton = ({ onClick, ...props }: ComponentProps<typeof Button> & { onClick: () => void }) => (
  <Button onClick={onClick} variant="ghost" size="icon" className="h-10 w-10 md:h-8 md:w-8 rounded-full" {...props}>
    <X className="size-5 md:size-4" />
  </Button>
)
