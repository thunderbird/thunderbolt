/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ModificationIndicator } from '@/components/modification-indicator'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/page-header'
import { SectionCard } from '@/components/ui/section-card'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { initialLocalSettings, useLocalSettingsStore } from '@/stores/local-settings-store'
import { useActiveCloudUrl, useTrustDomainRegistry } from '@/stores/trust-domain-registry'
import { getCapabilities, isTauri } from '@/lib/platform'
import { useQuery } from '@tanstack/react-query'
import { useShallow } from 'zustand/react/shallow'

// The env-var fallback the boot resolver uses. If it were unset, boot would fail with
// NO_TRUST_DOMAIN before this page renders, so a hardcoded localhost default would only
// drift from whatever the rest of the app considers "default."
const defaultCloudUrl = import.meta.env.VITE_THUNDERBOLT_CLOUD_URL ?? ''

export default function DevSettingsPage() {
  const settings = useLocalSettingsStore(
    useShallow((s) => ({
      isNativeFetchEnabled: s.isNativeFetchEnabled,
      debugPosthog: s.debugPosthog,
    })),
  )
  const { isNativeFetchEnabled, debugPosthog } = settings
  const setLocalSetting = useLocalSettingsStore((s) => s.setLocalSetting)

  // Cloud URL lives on the active server entry in the trust-domain registry; editing
  // it here updates the registry directly so runtime consumers (HTTP, PowerSync, etc.)
  // see the change on next read. Resetting falls back to the env-var default that the
  // boot resolver also uses. NOTE: changing the URL does NOT update the active server's
  // `serverId` — pointing at a different backend (different serverId) is post-v1 territory.
  const cloudUrl = useActiveCloudUrl() ?? defaultCloudUrl
  const patchActiveServer = useTrustDomainRegistry((s) => s.patchActiveServer)
  const setCloudUrl = (value: string) => patchActiveServer({ cloudUrl: value || defaultCloudUrl })

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
          {/* Cloud URL Setting */}
          <div className="space-y-2">
            <ModificationIndicator
              as="label"
              className="block text-sm font-medium"
              hasModifications={cloudUrl !== defaultCloudUrl}
              onReset={() => setCloudUrl(defaultCloudUrl)}
            >
              Cloud URL
            </ModificationIndicator>
            <Input
              type="url"
              value={cloudUrl}
              onChange={(e) => setCloudUrl(e.target.value)}
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
