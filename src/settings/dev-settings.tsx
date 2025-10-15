import { ModificationIndicator } from '@/components/modification-indicator'
import { Input } from '@/components/ui/input'
import { SectionCard } from '@/components/ui/section-card'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DatabaseSingleton } from '@/db/singleton'
import { settingsTable } from '@/db/tables'
import { useBooleanSetting, useSetting } from '@/hooks/use-setting'
import { resetSettingToDefault } from '@/lib/dal'
import { defaultSettings } from '@/lib/defaults/settings'
import { isSettingModified } from '@/lib/defaults/utils'
import { getCapabilities, isTauri } from '@/lib/platform'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

export default function DevSettingsPage() {
  const db = DatabaseSingleton.instance.db
  const queryClient = useQueryClient()

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

  // Query settings from DB to check for modifications
  const { data: dbSettings } = useQuery({
    queryKey: ['db-settings'],
    queryFn: async () => {
      const settings = await db.select().from(settingsTable)
      return settings.reduce(
        (acc, setting) => {
          acc[setting.key] = setting
          return acc
        },
        {} as Record<string, (typeof settings)[0]>,
      )
    },
  })

  // Check if each setting has been modified
  const isCloudUrlModified = dbSettings?.cloud_url ? isSettingModified(dbSettings.cloud_url) : false
  const isNativeFetchModified = dbSettings?.is_native_fetch_enabled
    ? isSettingModified(dbSettings.is_native_fetch_enabled)
    : false
  const isDisableEncryptionModified = dbSettings?.disable_flower_encryption
    ? isSettingModified(dbSettings.disable_flower_encryption)
    : false
  const isDebugPosthogModified = dbSettings?.debug_posthog ? isSettingModified(dbSettings.debug_posthog) : false

  // Reset mutations
  const resetMutation = useMutation({
    mutationFn: async ({ key, defaultSetting }: { key: string; defaultSetting: (typeof defaultSettings)[0] }) => {
      await resetSettingToDefault(key, defaultSetting)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] })
      queryClient.invalidateQueries({ queryKey: ['db-settings'] })
    },
  })

  const handleResetSetting = (key: string) => {
    const defaultSetting = defaultSettings.find((s) => s.key === key)
    if (defaultSetting) {
      resetMutation.mutate({ key, defaultSetting })
    }
  }

  return (
    <div className="flex flex-col gap-6 p-4 w-full max-w-[760px] mx-auto">
      <h1 className="mt-8 text-4xl font-bold tracking-tight mb-2 text-primary">Developer Settings</h1>

      <SectionCard title="Network">
        <div className="flex flex-col gap-8">
          {/* Cloud URL Setting */}
          <div className="space-y-2">
            <div className="flex items-center gap-1 -ml-[19px]">
              <ModificationIndicator
                hasModifications={isCloudUrlModified}
                onReset={() => handleResetSetting('cloud_url')}
              />
              <label className="block text-sm font-medium">Cloud URL</label>
            </div>
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
              <div className="flex items-center gap-1 -ml-[19px]">
                <ModificationIndicator
                  hasModifications={isNativeFetchModified}
                  onReset={() => handleResetSetting('is_native_fetch_enabled')}
                />
                <label className="text-sm font-medium">Use Native Fetch</label>
              </div>
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
              <div className="flex items-center gap-1 -ml-[19px]">
                <ModificationIndicator
                  hasModifications={isDisableEncryptionModified}
                  onReset={() => handleResetSetting('disable_flower_encryption')}
                />
                <label className="text-sm font-medium">Disable Encryption</label>
              </div>
              <p className="text-sm text-muted-foreground">Disable encryption even for confidential models</p>
            </div>
            <Switch checked={disableEncryption} onCheckedChange={setDisableEncryption} />
          </div>

          {/* Divider between settings */}
          <div className="border-t -mx-6" />

          <div className="flex items-center justify-between">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1 -ml-[19px]">
                <ModificationIndicator
                  hasModifications={isDebugPosthogModified}
                  onReset={() => handleResetSetting('debug_posthog')}
                />
                <label className="text-sm font-medium">Debug PostHog</label>
              </div>
              <p className="text-sm text-muted-foreground">Enable verbose analytics logging in the console</p>
            </div>
            <Switch checked={debugPosthog} onCheckedChange={setDebugPosthog} />
          </div>
        </div>
      </SectionCard>
    </div>
  )
}
