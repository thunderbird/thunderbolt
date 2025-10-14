import { cn } from '@/lib/utils'

type BadgeVariant = 'default' | 'secondary' | 'outline'

type BadgeProps = {
  children: React.ReactNode
  variant?: BadgeVariant
  className?: string
}

export const Badge = ({ children, variant = 'default', className }: BadgeProps) => {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        {
          'bg-primary text-primary-foreground': variant === 'default',
          'bg-secondary text-secondary-foreground': variant === 'secondary',
          'border border-input bg-background': variant === 'outline',
        },
        className,
      )}
    >
      {children}
    </span>
  )
}
