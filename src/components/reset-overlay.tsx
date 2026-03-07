import { Loader2 } from 'lucide-react'

type ResetOverlayProps = {
  open: boolean
  title: string
  description: string
}

export const ResetOverlay = ({ open, title, description }: ResetOverlayProps) => {
  if (!open) {
    return null
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-4 text-center px-6">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground max-w-sm">{description}</p>
      </div>
    </div>
  )
}
