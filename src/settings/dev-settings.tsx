import { ModificationIndicator } from '@/components/modification-indicator'
import { Input } from '@/components/ui/input'
import { SectionCard } from '@/components/ui/section-card'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useBooleanSetting, useSetting } from '@/hooks/use-setting'
import { getCapabilities, isTauri } from '@/lib/platform'
import { useQuery } from '@tanstack/react-query'

export default function DevSettingsPage() {
  // Use the new hooks for each setting
  const cloudUrl = useSetting('cloud_url', '')
  const tauriFetchEnabled = useBooleanSetting('is_native_fetch_enabled', false)
  const disableEncryption = useBooleanSetting('disable_flower_encryption', false)
  const debugPosthog = useBooleanSetting('debug_posthog', false)

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
            <ModificationIndicator
              as="label"
              className="block text-sm font-medium"
              hasModifications={cloudUrl.isModified}
              onReset={cloudUrl.reset}
            >
              Cloud URL
            </ModificationIndicator>
            <Input
              type="url"
              value={cloudUrl.value || ''}
              onChange={(e) => cloudUrl.setValue(e.target.value || null)}
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
                hasModifications={tauriFetchEnabled.isModified}
                onReset={tauriFetchEnabled.reset}
              >
                Use Native Fetch
              </ModificationIndicator>
              <p className="text-sm text-muted-foreground">Proxy HTTP requests through Tauri to bypass CORS</p>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Switch
                    checked={tauriFetchEnabled.value}
                    onCheckedChange={tauriFetchEnabled.setValue}
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
                hasModifications={disableEncryption.isModified}
                onReset={disableEncryption.reset}
              >
                Disable Encryption
              </ModificationIndicator>
              <p className="text-sm text-muted-foreground">Disable encryption even for confidential models</p>
            </div>
            <Switch checked={disableEncryption.value} onCheckedChange={disableEncryption.setValue} />
          </div>

          {/* Divider between settings */}
          <div className="border-t -mx-6" />

          <div className="flex items-center justify-between">
            <div className="flex flex-col gap-1">
              <ModificationIndicator
                as="label"
                className="text-sm font-medium"
                hasModifications={debugPosthog.isModified}
                onReset={debugPosthog.reset}
              >
                Debug PostHog
              </ModificationIndicator>
              <p className="text-sm text-muted-foreground">Enable verbose analytics logging in the console</p>
            </div>
            <Switch checked={debugPosthog.value} onCheckedChange={debugPosthog.setValue} />
          </div>
        </div>
      </SectionCard>
    </div>
  )
}
