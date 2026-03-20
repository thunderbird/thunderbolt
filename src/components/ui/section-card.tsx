import type { ReactNode } from 'react'
import { Card, CardContent } from './card'

type SectionCardProps = {
  title: string
  children: ReactNode
  className?: string
}

export const SectionCard = ({ title, children, className }: SectionCardProps) => {
  return (
    <>
      <h3 className="text-lg font-semibold -mb-2">{title}</h3>
      <Card className={className}>
        <CardContent>{children}</CardContent>
      </Card>
    </>
  )
}
