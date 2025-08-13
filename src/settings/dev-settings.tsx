import { useBooleanSetting, useSetting } from '@/hooks/use-setting'
import { getCapabilities, isTauri } from '@/lib/platform'
import { useQuery } from '@tanstack/react-query'

import { Input } from '@/components/ui/input'
import { SectionCard } from '@/components/ui/section-card'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export default function DevSettingsPage() {
  // Tauri fetch setting
  const [tauriFetchEnabled, setTauriFetchEnabled] = useBooleanSetting('is_native_fetch_enabled', false)

  // Cloud URL setting
  const [cloudUrl, setCloudUrl] = useSetting('cloud_url', '')

  // Disable encryption setting
  const [disableEncryption, setDisableEncryption] = useBooleanSetting('disable_flower_encryption', false)

  // Debug PostHog analytics
  const [debugPosthog, setDebugPosthog] = useBooleanSetting('debug_posthog', false)

  // Runtime capabilities
  const { data: capabilities } = useQuery({
    queryKey: ['capabilities'],
    queryFn: getCapabilities,
    enabled: isTauri(),
  })

  return (
    <div className="flex flex-col gap-6 p-4 w-full max-w-[760px] mx-auto">
      <h1 className="mt-8 text-4xl font-bold tracking-tight mb-2 text-primary">Developer Settings</h1>

      <SectionCard title="Network">
        <div className="flex flex-col gap-8">
          {/* Cloud URL Setting */}
          <div className="space-y-2">
            <label className="block text-sm font-medium">Cloud URL</label>
            <Input
              type="url"
              value={cloudUrl || ''}
              onChange={(e) => setCloudUrl(e.target.value)}
              placeholder="http://localhost:8000"
            />
            <p className="text-sm text-muted-foreground">The URL of the Thunderbolt backend</p>
          </div>

          {/* Divider between settings */}
          <div className="border-t -mx-6" />

          <div className="flex items-center justify-between">
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">Use Native Fetch</label>
              <p className="text-sm text-muted-foreground">Proxy HTTP requests through Tauri to bypass CORS</p>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Switch
                    checked={tauriFetchEnabled}
                    onCheckedChange={setTauriFetchEnabled}
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
              <label className="text-sm font-medium">Disable Encryption</label>
              <p className="text-sm text-muted-foreground">Disable encryption even for confidential models</p>
            </div>
            <Switch checked={disableEncryption} onCheckedChange={setDisableEncryption} />
          </div>

          {/* Divider between settings */}
          <div className="border-t -mx-6" />

          <div className="flex items-center justify-between">
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">Debug PostHog</label>
              <p className="text-sm text-muted-foreground">Enable verbose analytics logging in the console</p>
            </div>
            <Switch checked={debugPosthog} onCheckedChange={setDebugPosthog} />
          </div>
        </div>
      </SectionCard>
    </div>
  )
}
