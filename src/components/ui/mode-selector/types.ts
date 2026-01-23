import type { Mode } from '@/types'

export type ModeSelectorProps = {
  modes: Mode[]
  selectedMode: Mode | null
  onModeChange: (modeId: string) => void
}
