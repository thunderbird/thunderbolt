/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ModificationIndicator } from '@/components/modification-indicator'
import { PageHeader } from '@/components/ui/page-header'
import { SectionCard } from '@/components/ui/section-card'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { initialLocalSettings, useLocalSettingsStore } from '@/stores/local-settings-store'
import { getCapabilities, isTauri } from '@/lib/platform'
import { useQuery } from '@tanstack/react-query'
import { useShallow } from 'zustand/react/shallow'

export default function DevSettingsPage() {
  const settings = useLocalSettingsStore(
    useShallow((s) => ({
      isNativeFetchEnabled: s.isNativeFetchEnabled,
      debugPosthog: s.debugPosthog,
    })),
  )
  const { isNativeFetchEnabled, debugPosthog } = settings
  const setLocalSetting = useLocalSettingsStore((s) => s.setLocalSetting)

  const isModified = <K extends keyof typeof settings>(key: K) => settings[key] !== initialLocalSettings[key]

  const resetSetting = <K extends keyof typeof initialLocalSettings>(key: K) =>
    setLocalSetting(key, initialLocalSettings[key])

  const { data: capabilities } = useQuery({
    queryKey: ['capabilities'],
    queryFn: getCapabilities,
    enabled: isTauri(),
  })

  return (
    <div className="flex flex-col gap-6 p-4 w-full max-w-[760px] mx-auto">
      <PageHeader title="Developer Settings" />

      <SectionCard title="Network">
        <div className="flex flex-col gap-8">
          <div className="flex items-center justify-between">
            <div className="flex flex-col gap-1">
              <ModificationIndicator
                as="label"
                className="text-sm font-medium"
                hasModifications={isModified('isNativeFetchEnabled')}
                onReset={() => resetSetting('isNativeFetchEnabled')}
              >
                Use Native Fetch
              </ModificationIndicator>
              <p className="text-sm text-muted-foreground">Proxy HTTP requests through Tauri to bypass CORS</p>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Switch
                    checked={isNativeFetchEnabled}
                    onCheckedChange={(value) => setLocalSetting('isNativeFetchEnabled', value)}
                    disabled={!capabilities?.native_fetch}
                  />
                </span>
              </TooltipTrigger>
              {!capabilities?.native_fetch && (
                <TooltipContent sideOffset={4}>
                  This feature is only available on some desktop versions of the app that were built with the
                  native_fetch feature flag.
                </TooltipContent>
              )}
            </Tooltip>
          </div>

          {/* Divider between settings */}
          <div className="border-t -mx-6" />

          <div className="flex items-center justify-between">
            <div className="flex flex-col gap-1">
              <ModificationIndicator
                as="label"
                className="text-sm font-medium"
                hasModifications={isModified('debugPosthog')}
                onReset={() => resetSetting('debugPosthog')}
              >
                Debug PostHog
              </ModificationIndicator>
              <p className="text-sm text-muted-foreground">Enable verbose analytics logging in the console</p>
            </div>
            <Switch checked={debugPosthog} onCheckedChange={(value) => setLocalSetting('debugPosthog', value)} />
          </div>
        </div>
      </SectionCard>
    </div>
  )
}
