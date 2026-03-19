import type { ReactNode } from 'react'

type PageHeaderProps = {
  title: string
  children?: ReactNode
}

/**
 * Consistent page header with title and optional action buttons.
 *
 * @example
 * ```tsx
 * <PageHeader title="Models">
 *   <Button size="icon" className="rounded-lg">
 *     <Plus />
 *   </Button>
 * </PageHeader>
 * ```
 */
export const PageHeader = ({ title, children }: PageHeaderProps) => (
  <div className="flex items-center justify-between mt-4">
    <h1 className="text-4xl font-bold tracking-tight text-primary">{title}</h1>
    <div className="flex items-center gap-1 pr-2">{children}</div>
  </div>
)
