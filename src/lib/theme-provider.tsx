import { settingsTable } from '@/db/tables'
import { DatabaseSingleton } from '@/db/singleton'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { getThemeSetting } from '@/lib/dal'

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

export function ThemeProvider({
  children,
  defaultTheme = 'system',
  storageKey = 'ui-theme',
  ...props
}: ThemeProviderProps) {
  const db = DatabaseSingleton.instance.db
  const queryClient = useQueryClient()
  const [theme, setTheme] = useState<Theme>(defaultTheme)

  const { data: savedTheme } = useQuery({
    queryKey: ['settings', storageKey],
    queryFn: () => getThemeSetting(storageKey, defaultTheme),
  })

  useEffect(() => {
    if (savedTheme) {
      setTheme(savedTheme as Theme)
    }
  }, [savedTheme])

  const saveThemeMutation = useMutation({
    mutationFn: async (newTheme: Theme) => {
      await db
        .insert(settingsTable)
        .values({ key: storageKey, value: newTheme })
        .onConflictDoUpdate({
          target: settingsTable.key,
          set: { value: newTheme },
        })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings', storageKey] })
    },
  })

  useEffect(() => {
    const root = window.document.documentElement

    root.classList.remove('light', 'dark')

    if (theme === 'system') {
      const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'

      root.classList.add(systemTheme)
      return
    }

    root.classList.add(theme)
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
    setTheme: (theme: Theme) => {
      setTheme(theme)
      saveThemeMutation.mutate(theme)
    },
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
