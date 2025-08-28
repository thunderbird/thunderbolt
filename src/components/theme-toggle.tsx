import { Monitor, Moon, Sun } from 'lucide-react'

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTheme } from '@/lib/theme-provider'
import { trackEvent } from '@/lib/analytics'

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()

  return (
    <ToggleGroup
      type="single"
      variant="outline"
      value={theme}
      onValueChange={(value) => {
        setTheme(value as 'light' | 'dark' | 'system')
        trackEvent('settings_theme_set', { theme: value })
      }}
      className="justify-start"
    >
      <ToggleGroupItem value="light" aria-label="Light mode" className="gap-2 px-4 cursor-pointer">
        <Sun className="h-4 w-4" />
        Light
      </ToggleGroupItem>
      <ToggleGroupItem value="dark" aria-label="Dark mode" className="gap-2 px-4 cursor-pointer">
        <Moon className="h-4 w-4" />
        Dark
      </ToggleGroupItem>
      <ToggleGroupItem value="system" aria-label="System theme" className="gap-2 px-4 cursor-pointer">
        <Monitor className="h-4 w-4" />
        System
      </ToggleGroupItem>
    </ToggleGroup>
  )
}
