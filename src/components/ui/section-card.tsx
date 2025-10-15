import type { ReactNode } from 'react'
import { Card, CardContent } from './card'

interface SectionCardProps {
  title: string
  children: ReactNode
  className?: string
}

export function SectionCard({ title, children, className }: SectionCardProps) {
  return (
    <>
      <h3 className="text-lg font-semibold -mb-2">{title}</h3>
      <Card className={className}>
        <CardContent className="pt-6">{children}</CardContent>
      </Card>
    </>
  )
}
