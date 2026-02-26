import { useEffect, useState } from 'react'

const mobileBreakpoint = 768

export const useIsMobile = () => {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < mobileBreakpoint)

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${mobileBreakpoint - 1}px)`)
    const onChange = () => setIsMobile(window.innerWidth < mobileBreakpoint)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return { isMobile }
}
