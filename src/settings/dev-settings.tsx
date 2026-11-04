/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ModificationIndicator } from '@/components/modification-indicator'
import { ServerConnectionForm } from '@/components/server-connection'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/page-header'
import { SectionCard } from '@/components/ui/section-card'
import { SettingsPageShell } from '@/components/settings/settings-list'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { initialLocalSettings, useLocalSettingsStore } from '@/stores/local-settings-store'
import { isTauri } from '@/lib/platform'
import { useShallow } from 'zustand/react/shallow'
import { Trans, useLingui } from '@lingui/react/macro'

export default function DevSettingsPage() {
  const { t } = useLingui()
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
          <div className="space-y-2">
            {cloudUrl ? (
              <>
                <label className="block text-sm font-medium" htmlFor="developer-cloud-url">
                  <Trans>Thunderbolt Server</Trans>
                </label>
                <Input
                  id="developer-cloud-url"
                  type="url"
                  value={cloudUrl}
                  readOnly
                  aria-label={t`Thunderbolt Server`}
                />
                <p className="text-sm text-muted-foreground">
                  <Trans>
                    Reset local data before choosing a different server so account credentials and data stay separate.
                  </Trans>
                </p>
              </>
            ) : (
              <ServerConnectionForm />
            )}
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
