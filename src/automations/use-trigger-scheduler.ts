import { useSettings } from '@/hooks/use-settings'
import { getAllEnabledTriggers, runAutomation } from '@/dal'
import { useEffect, useRef } from 'react'

export const useTriggerScheduler = () => {
  const { isTriggersEnabled } = useSettings({
    is_triggers_enabled: false,
  })
  const timers = useRef<number[]>([])

  useEffect(() => {
    const plan = async () => {
      if (!isTriggersEnabled.value) {
        return
      }

      timers.current.forEach(clearTimeout)
      timers.current = []

      const triggers = await getAllEnabledTriggers()

      triggers.forEach((t) => {
        if (t.triggerTime) {
          const [h, m] = t.triggerTime.split(':').map(Number)
          const next = new Date()
          next.setHours(h, m, 0, 0)
          if (next < new Date()) next.setDate(next.getDate() + 1)
          const delay = next.getTime() - Date.now()
          timers.current.push(
            setTimeout(() => runAutomation(t.promptId).catch(console.error), delay) as unknown as number,
          )
        }
      })
    }

    if (!isTriggersEnabled.value) {
      return
    }

    plan()

    const id = setInterval(plan, 60_000)

    return () => {
      clearInterval(id)
      timers.current.forEach(clearTimeout)
    }
  }, [isTriggersEnabled.value])
}
