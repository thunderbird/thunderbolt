import { X } from 'lucide-react'
import { type ComponentProps } from 'react'
import { Button } from './button'

export const SidebarCloseButton = ({ onClick, ...props }: ComponentProps<typeof Button> & { onClick: () => void }) => (
  <Button onClick={onClick} variant="ghost" size="icon" className="size-[var(--touch-height-sm)] rounded-lg" {...props}>
    <X className="size-[var(--icon-size-default)]" />
  </Button>
)
