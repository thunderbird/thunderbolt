/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ModificationIndicator } from '@/components/modification-indicator'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/page-header'
import { SectionCard } from '@/components/ui/section-card'
import { SettingsPageShell } from '@/components/settings/settings-list'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { initialLocalSettings, useLocalSettingsStore } from '@/stores/local-settings-store'
import { isTauri } from '@/lib/platform'
import { useShallow } from 'zustand/react/shallow'

export default function DevSettingsPage() {
  const settings = useLocalSettingsStore(
    useShallow((s) => ({
      cloudUrl: s.cloudUrl,
      isNativeFetchEnabled: s.isNativeFetchEnabled,
      debugPosthog: s.debugPosthog,
    })),
  )
  const { cloudUrl, isNativeFetchEnabled, debugPosthog } = settings
  const setLocalSetting = useLocalSettingsStore((s) => s.setLocalSetting)

  const isModified = <K extends keyof typeof settings>(key: K) => settings[key] !== initialLocalSettings[key]

  const resetSetting = <K extends keyof typeof initialLocalSettings>(key: K) =>
    setLocalSetting(key, initialLocalSettings[key])

  return (
    <SettingsPageShell className="gap-6">
      <PageHeader title="Developer Settings" />

      <SectionCard title="Network">
        <div className="flex flex-col gap-8">
          {/* Cloud URL Setting */}
          <div className="space-y-2">
            <ModificationIndicator
              as="label"
              className="block text-sm font-medium"
              hasModifications={isModified('cloudUrl')}
              onReset={() => resetSetting('cloudUrl')}
            >
              Cloud URL
            </ModificationIndicator>
            <Input
              type="url"
              value={cloudUrl}
              onChange={(e) => setLocalSetting('cloudUrl', e.target.value)}
              // Consumers (http client, PowerSync, ACP transports) can't work
              // with a blank base URL, but snapping back mid-edit would make
              // the field impossible to clear and retype — so restore the
              // default only when the field is left empty.
              onBlur={(e) => {
                if (e.target.value.trim() === '') {
                  resetSetting('cloudUrl')
                }
              }}
              placeholder="http://localhost:8000"
            />
            <p className="text-sm text-muted-foreground">The URL of the Thunderbolt backend</p>
          </div>

          {/* Divider between settings */}
          <div className="border-t -mx-6" />

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
                    disabled={!isTauri()}
                  />
                </span>
              </TooltipTrigger>
              {!isTauri() && (
                <TooltipContent sideOffset={4}>Native HTTP is only available in the Tauri app.</TooltipContent>
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
    </SettingsPageShell>
  )
}
