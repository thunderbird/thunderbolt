/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ModificationIndicator } from '@/components/modification-indicator'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/page-header'
import { SectionCard } from '@/components/ui/section-card'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAuth } from '@/contexts'
import { useLocalStorage } from '@/hooks/use-local-storage'
import { initialLocalSettings, useLocalSettingsStore } from '@/stores/local-settings-store'
import { getCapabilities, isTauri } from '@/lib/platform'
import { computeEffectiveProxyEnabled } from '@/lib/proxy-fetch'
import { useQuery } from '@tanstack/react-query'
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

  const { data: capabilities } = useQuery({
    queryKey: ['capabilities'],
    queryFn: getCapabilities,
    enabled: isTauri(),
  })

  const authClient = useAuth()
  const { data: session } = authClient.useSession()
  const isAuthenticated = !!session?.user

  // Network: `proxy_enabled` is device-local (localStorage) because it controls
  // request transport (privacy on Tauri vs. CORS bypass on Web), not a synced
  // user preference. Web ignores the stored value — browser CORS forces the
  // proxy path — so the toggle is UI-disabled with an explanatory tooltip.
  const onTauri = isTauri()
  const [proxyEnabledStr, setProxyEnabledStr] = useLocalStorage('proxy_enabled', 'false')
  const effectiveProxyEnabled = computeEffectiveProxyEnabled(
    () => onTauri,
    () => proxyEnabledStr,
  )
  const proxyDisabled = !onTauri || !isAuthenticated
  const proxyTooltipReason = !onTauri
    ? 'Proxying is required in the web app to bypass browser CORS restrictions.'
    : 'Sign in to enable cloud proxy.'
  // When the toggle is auth-disabled, render it as OFF so the UI honestly reflects
  // that the user can't use the proxy until they sign in.
  const proxyChecked = proxyDisabled && onTauri ? false : effectiveProxyEnabled

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
              hasModifications={isModified('cloudUrl')}
              onReset={() => resetSetting('cloudUrl')}
            >
              Cloud URL
            </ModificationIndicator>
            <Input
              type="url"
              value={cloudUrl}
              onChange={(e) => setLocalSetting('cloudUrl', e.target.value || initialLocalSettings.cloudUrl)}
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
              <label className="text-sm font-medium">Use Cloud Proxy</label>
              <p className="text-sm text-muted-foreground">
                When enabled, requests are routed through Thunderbolt's cloud proxy.
              </p>
            </div>
            {proxyDisabled ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0} aria-label={proxyTooltipReason}>
                    <Switch
                      checked={proxyChecked}
                      disabled
                      aria-label="Use Cloud Proxy"
                      className="pointer-events-none"
                    />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p>{proxyTooltipReason}</p>
                </TooltipContent>
              </Tooltip>
            ) : (
              <Switch
                checked={proxyChecked}
                onCheckedChange={(checked) => setProxyEnabledStr(checked ? 'true' : 'false')}
                aria-label="Use Cloud Proxy"
              />
            )}
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
