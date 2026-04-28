import { ModificationIndicator } from '@/components/modification-indicator'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/page-header'
import { SectionCard } from '@/components/ui/section-card'
import { Switch } from '@/components/ui/switch'
import { useSettings } from '@/hooks/use-settings'
import { isTauri } from '@/lib/platform'

export default function DevSettingsPage() {
  const { cloudUrl, isNativeFetchEnabled, debugPosthog } = useSettings({
    cloud_url: '',
    is_native_fetch_enabled: false,
    debug_posthog: false,
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
              hasModifications={cloudUrl.isModified}
              onReset={cloudUrl.reset}
            >
              Cloud URL
            </ModificationIndicator>
            <Input
              type="url"
              value={cloudUrl.value}
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
                hasModifications={isNativeFetchEnabled.isModified}
                onReset={isNativeFetchEnabled.reset}
              >
                Use Native Fetch
              </ModificationIndicator>
              <p className="text-sm text-muted-foreground">Proxy HTTP requests through Tauri to bypass CORS</p>
            </div>
            <Switch
              checked={isNativeFetchEnabled.value}
              onCheckedChange={isNativeFetchEnabled.setValue}
              disabled={!isTauri()}
            />
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
