import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { M3 } from 'tauri-plugin-m3'
import { isTauri } from './platform'

type Theme = 'dark' | 'light' | 'system'

type ThemeProviderProps = {
  children: ReactNode
  defaultTheme?: Theme
  storageKey?: string
}

type ThemeProviderState = {
  theme: Theme
  setTheme: (theme: Theme) => void
}

const initialState: ThemeProviderState = {
  theme: 'system',
  setTheme: () => null,
}

const ThemeProviderContext = createContext<ThemeProviderState>(initialState)

const isValidTheme = (value: string | null): value is Theme =>
  value === 'dark' || value === 'light' || value === 'system'

export function ThemeProvider({
  children,
  defaultTheme = 'system',
  storageKey = 'ui-theme',
  ...props
}: ThemeProviderProps) {
  const savedTheme = window.localStorage.getItem(storageKey)

  const [theme, setTheme] = useState<Theme>(isValidTheme(savedTheme) ? savedTheme : defaultTheme)

  useEffect(() => {
    window.localStorage.setItem(storageKey, theme)
  }, [storageKey, theme])

  useEffect(() => {
    const root = window.document.documentElement
    const metaThemeColor = document.querySelector('meta[name="theme-color"]')

    root.classList.remove('light', 'dark')

    if (theme === 'system') {
      const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'

      root.classList.add(systemTheme)

      metaThemeColor?.setAttribute('content', systemTheme === 'dark' ? '#0a0a0a' : '#fff')

      if (isTauri()) {
        M3.setBarColor(systemTheme === 'dark' ? 'light' : 'dark')
      }

      return
    }

    root.classList.add(theme)

    metaThemeColor?.setAttribute('content', theme === 'dark' ? '#0a0a0a' : '#fff')

    if (isTauri()) {
      M3.setBarColor(theme === 'dark' ? 'light' : 'dark')
    }
  }, [theme])

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

    const handleChange = () => {
      if (theme === 'system') {
        const root = window.document.documentElement
        root.classList.remove('light', 'dark')

        const systemTheme = mediaQuery.matches ? 'dark' : 'light'
        root.classList.add(systemTheme)
      }
    }

    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [theme])

  const value = {
    theme,
    setTheme,
  }

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  )
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext)

  if (context === undefined) throw new Error('useTheme must be used within a ThemeProvider')

  return context
}
