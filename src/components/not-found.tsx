import { AppLogo } from '@/components/app-logo'
import { Button } from '@/components/ui/button'
import { useNavigate } from 'react-router'

export const NotFound = () => {
  const navigate = useNavigate()

  return (
    <div className="flex flex-col items-center justify-center w-full h-dvh">
      <div className="flex flex-col items-center gap-8 text-center">
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <AppLogo size={16} />
          <span>Thunderbolt</span>
        </div>

        <h1 className="text-4xl font-semibold tracking-tight">Not Found</h1>

        <Button variant="secondary" onClick={() => navigate('/chats/new', { replace: true })}>
          Back to App
        </Button>
      </div>
    </div>
  )
}

export default NotFound
