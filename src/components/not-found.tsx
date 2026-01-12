import { Button } from '@/components/ui/button'
import { FileQuestion } from 'lucide-react'
import { useNavigate } from 'react-router'

type NotFoundProps = {
  title?: string
  description?: string
}

export const NotFound = ({
  title = 'Page not found',
  description = "The page you're looking for doesn't exist or has been removed.",
}: NotFoundProps) => {
  const navigate = useNavigate()

  return (
    <div className="flex flex-col items-center justify-center w-full h-[100vh] p-4">
      <div className="flex flex-col items-center gap-6 max-w-md text-center">
        <div className="rounded-full bg-muted p-4">
          <FileQuestion className="h-12 w-12 text-muted-foreground" />
        </div>

        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="text-muted-foreground">{description}</p>
        </div>

        <Button onClick={() => navigate('/chats/new', { replace: true })}>Start a new chat</Button>
      </div>
    </div>
  )
}

export default NotFound
