import { type ReactNode } from 'react'

type IconCircleProps = {
  children: ReactNode
  size?: number
}

/**
 * Reusable icon circle for onboarding steps
 */
export const IconCircle = ({ children, size = 16 }: IconCircleProps) => {
  return (
    <div
      className={`mx-auto bg-white dark:bg-gray-800 rounded-full flex items-center justify-center shadow-sm border`}
      style={{ width: `${size * 4}px`, height: `${size * 4}px` }}
    >
      {children}
    </div>
  )
}
