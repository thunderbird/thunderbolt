import { Loader2 } from 'lucide-react'
import { type FC } from 'react'

interface LoadingProps {
  className?: string
  size?: number
}

export const Loading: FC<LoadingProps> = ({ className, size = 24 }) => {
  return (
    <div className="flex items-center justify-center w-full h-[100vh]">
      <Loader2 className={`animate-spin text-gray-500 ${className || ''}`} size={size} />
    </div>
  )
}

export default Loading
