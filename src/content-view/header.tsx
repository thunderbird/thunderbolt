import { SidebarCloseButton } from '@/components/ui/sidebar-close-button'
import { type ReactNode } from 'react'

type ContentViewHeaderProps = {
  title: string
  onClose: () => void
  actions?: ReactNode
  className?: string
}

/**
 * Reusable header component for content views
 * Provides consistent layout with title, optional actions, and close button
 */
export const ContentViewHeader = ({ title, onClose, actions, className = '' }: ContentViewHeaderProps) => {
  return (
    <div className={`flex h-12 w-full items-center justify-between px-4 flex-shrink-0 ${className}`.trim()}>
      <h2 className="text-lg font-semibold truncate">{title}</h2>
      <div className="flex items-center gap-2">
        {actions}
        <SidebarCloseButton onClick={onClose} />
      </div>
    </div>
  )
}
