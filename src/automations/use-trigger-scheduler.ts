/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDb } from '@/db/database'
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

      const db = getDb()
      const triggers = await getAllEnabledTriggers(db)

      triggers.forEach((t) => {
        if (t.triggerTime) {
          const [h, m] = t.triggerTime.split(':').map(Number)
          const next = new Date()
          next.setHours(h, m, 0, 0)
          if (next < new Date()) {
            next.setDate(next.getDate() + 1)
          }
          const delay = next.getTime() - Date.now()
          timers.current.push(
            setTimeout(() => runAutomation(getDb(), t.promptId).catch(console.error), delay) as unknown as number,
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
