import { useAuth } from '@/contexts'
import { useSignInModal } from '@/contexts/sign-in-modal-context'
import { useCountryUnits } from '@/hooks/use-country-units'
import type { LocationData } from '@/hooks/use-location-search'
import { useSettings } from '@/hooks/use-settings'
import { useUnitsOptions } from '@/hooks/use-units-options'
import { privacyPolicyUrl } from '@/lib/constants'
import { extractCountryFromLocation } from '@/lib/country-utils'
import { clearLocalData } from '@/lib/cleanup'
import { trackEvent } from '@/lib/posthog'
import type { CountryUnitsData } from '@/types'
import { useHttpClient } from '@/contexts'
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'

import { LocationSearchCombobox } from '@/components/location-search-combobox'
import { ModificationIndicator } from '@/components/modification-indicator'
import { TelemetryRequiredModal, type TelemetryRequiredModalRef } from '@/components/telemetry-required-modal'
import { TelemetryWarningModal, type TelemetryWarningModalRef } from '@/components/telemetry-warning-modal'
import { ThemeToggle } from '@/components/theme-toggle'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { SyncSetupModal } from '@/components/sync-setup/sync-setup-modal'
import { Button } from '@/components/ui/button'
import { Combobox } from '@/components/ui/combobox'
import { PageHeader } from '@/components/ui/page-header'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SectionCard } from '@/components/ui/section-card'
import { Switch } from '@/components/ui/switch'
import { usePostHog } from 'posthog-js/react'
import { usePowerSyncStatus } from '@/hooks/use-powersync-status'
import { useSyncEnabledToggle } from '@/hooks/use-sync-enabled-toggle'
import { defaultCloudUrlValue } from '@/defaults/settings'

type PreferencesState = {
  isResetting: boolean
  isDeletingAccount: boolean
  localizationDialogOpen: boolean
  pendingCountryUnits: CountryUnitsData | null
}

type PreferencesAction =
  | { type: 'SET_IS_RESETTING'; payload: boolean }
  | { type: 'SET_IS_DELETING_ACCOUNT'; payload: boolean }
  | { type: 'RESET_STATE' }
  | { type: 'OPEN_LOCALIZATION_DIALOG'; payload: CountryUnitsData }
  | { type: 'CLOSE_LOCALIZATION_DIALOG' }

const initialState: PreferencesState = {
  isResetting: false,
  isDeletingAccount: false,
  localizationDialogOpen: false,
  pendingCountryUnits: null,
}

const preferencesReducer = (state: PreferencesState, action: PreferencesAction): PreferencesState => {
  switch (action.type) {
    case 'SET_IS_RESETTING':
      return { ...state, isResetting: action.payload }
    case 'SET_IS_DELETING_ACCOUNT':
      return { ...state, isDeletingAccount: action.payload }
    case 'RESET_STATE':
      return initialState
    case 'OPEN_LOCALIZATION_DIALOG':
      return { ...state, localizationDialogOpen: true, pendingCountryUnits: action.payload }
    case 'CLOSE_LOCALIZATION_DIALOG':
      return { ...state, localizationDialogOpen: false, pendingCountryUnits: null }
    default:
      return state
  }
}

export default function PreferencesSettingsPage() {
  const [state, dispatch] = useReducer(preferencesReducer, initialState)
  const { isResetting, isDeletingAccount, localizationDialogOpen, pendingCountryUnits } = state
  const authClient = useAuth()
  const { data: session } = authClient.useSession()
  const isAuthenticated = !!session?.user
  const { openSignInModal } = useSignInModal()

  const { fetchCountryUnits } = useCountryUnits()

  const telemetryRequiredModalRef = useRef<TelemetryRequiredModalRef>(null)
  const telemetryWarningModalRef = useRef<TelemetryWarningModalRef>(null)

  const postHog = usePostHog()

  const httpClient = useHttpClient()
  const { syncEnabled, syncSetupOpen, setSyncSetupOpen, handleSyncToggle, handleSyncSetupComplete } =
    useSyncEnabledToggle()
  const { connectionStatus } = usePowerSyncStatus()
  const isConnecting = connectionStatus === 'connecting'

  // Use our useSettings hook for all settings
  const {
    preferredName,
    locationName,
    locationLat,
    locationLng,
    dataCollection,
    experimentalFeatureTasks,
    hapticsEnabled,
    distanceUnit,
    temperatureUnit,
    dateFormat,
    timeFormat,
    currency,
  } = useSettings({
    preferred_name: '',
    location_name: '',
    location_lat: '',
    location_lng: '',
    data_collection: true,
    experimental_feature_tasks: false,
    haptics_enabled: true,
    distance_unit: 'imperial',
    temperature_unit: 'f',
    date_format: 'MM/DD/YYYY',
    time_format: '12h',
    currency: 'USD',
    cloud_url: defaultCloudUrlValue,
  })

  // Local state for name input (only save on blur to avoid DB writes on every keystroke)
  const [nameInput, setNameInput] = useState('')
  const prevPreferredNameRef = useRef(preferredName.value)

  // Get units options and country units for localization
  const { data: unitsOptionsData, isLoading: unitsOptionsLoading } = useUnitsOptions()
  const { data: countryUnitsData, isLoading: countryUnitsLoading } = useCountryUnits()

  const handleEnableTelemetry = async (featureName?: string | null) => {
    await dataCollection.setValue(true)
    if (featureName === 'experimentalFeatureTasks') {
      await experimentalFeatureTasks.setValue(true)
    }
  }

  const handleDisableTelemetry = async () => {
    await dataCollection.setValue(false)
    await experimentalFeatureTasks.setValue(false)
  }

  // Sync local name input when settings value changes (e.g., async load)
  if (preferredName.value !== prevPreferredNameRef.current) {
    prevPreferredNameRef.current = preferredName.value
    setNameInput(preferredName.value || '')
  }

  // Auto-populate localization settings from country data if not set
  useEffect(() => {
    if (countryUnitsData && !countryUnitsLoading) {
      const hasLocalizationSettings =
        distanceUnit.value || temperatureUnit.value || dateFormat.value || timeFormat.value || currency.value

      if (!hasLocalizationSettings) {
        // Auto-set from country data and establish these as the baseline for future modifications
        distanceUnit.setValue(countryUnitsData.unit, { recomputeHash: true })
        temperatureUnit.setValue(countryUnitsData.temperature, { recomputeHash: true })
        dateFormat.setValue(countryUnitsData.dateFormatExample, { recomputeHash: true })
        timeFormat.setValue(countryUnitsData.timeFormat, { recomputeHash: true })
        currency.setValue(countryUnitsData.currency.code, { recomputeHash: true })
      }
    }
  }, [countryUnitsData, countryUnitsLoading, distanceUnit, temperatureUnit, dateFormat, timeFormat, currency])

  const handleDataCollectionToggle = async (value: boolean) => {
    // If turning off telemetry and preview features are enabled, show warning first
    if (!value && experimentalFeatureTasks.value) {
      telemetryWarningModalRef.current?.open()
      return
    }

    await dataCollection.setValue(value)

    if (value) {
      postHog.opt_in_capturing()
      trackEvent('settings_data_collection_enabled')
    } else {
      trackEvent('settings_data_collection_disabled')
      postHog.opt_out_capturing()
      // Also disable experimental features
      await experimentalFeatureTasks.setValue(false)
      trackEvent('settings_experimental_feature_tasks_disabled')
    }
  }

  const handleExperimentalFeaturesToggle = async (value: boolean) => {
    if (value && !dataCollection.value) {
      telemetryRequiredModalRef.current?.open('experimentalFeatureTasks')
      return
    }

    await experimentalFeatureTasks.setValue(value)
    trackEvent(value ? 'settings_experimental_feature_tasks_enabled' : 'settings_experimental_feature_tasks_disabled')
  }

  const handleSelectLocation = async (location: LocationData) => {
    const wasSet = !!locationName.value

    // Get current country to compare
    const currentCountry = extractCountryFromLocation(locationName.value || '')
    const newCountry = extractCountryFromLocation(location.name)

    await Promise.all([
      locationName.setValue(location.name),
      locationLat.setValue(String(location.coordinates.lat)),
      locationLng.setValue(String(location.coordinates.lng)),
    ])

    trackEvent(wasSet ? 'settings_location_update' : 'settings_location_set', {
      location_name: location.name,
    })

    // If country changed, ask user if they want to update localization settings
    if (newCountry && currentCountry !== newCountry) {
      const countryUnitsData = await fetchCountryUnits(newCountry)
      if (countryUnitsData) {
        dispatch({ type: 'OPEN_LOCALIZATION_DIALOG', payload: countryUnitsData })
      }
    }
  }

  const handleApplyLocalizationSettings = async () => {
    if (!pendingCountryUnits) {
      return
    }

    // Apply all localization settings with recomputeHash to establish new baselines
    await Promise.all([
      distanceUnit.setValue(pendingCountryUnits.unit, { recomputeHash: true }),
      temperatureUnit.setValue(pendingCountryUnits.temperature, { recomputeHash: true }),
      dateFormat.setValue(pendingCountryUnits.dateFormatExample, { recomputeHash: true }),
      timeFormat.setValue(pendingCountryUnits.timeFormat, { recomputeHash: true }),
      currency.setValue(pendingCountryUnits.currency.code, { recomputeHash: true }),
    ])

    dispatch({ type: 'CLOSE_LOCALIZATION_DIALOG' })
    trackEvent('settings_localization_update')
  }

  const handleDeclineLocalizationSettings = () => {
    dispatch({ type: 'CLOSE_LOCALIZATION_DIALOG' })
  }

  const [deleteAccountError, setDeleteAccountError] = useState<string | null>(null)

  const handleResetDatabase = async () => {
    dispatch({ type: 'SET_IS_RESETTING', payload: true })
    try {
      await clearLocalData()
      trackEvent('settings_database_reset')
      window.location.reload()
    } catch (error) {
      console.error('Failed to reset database:', error)
      dispatch({ type: 'SET_IS_RESETTING', payload: false })
    }
  }

  const handleDeleteAccount = async () => {
    setDeleteAccountError(null)
    dispatch({ type: 'SET_IS_DELETING_ACCOUNT', payload: true })

    try {
      await httpClient.delete('account', { credentials: 'omit' })
      await clearLocalData()
      window.location.reload()
    } catch (error) {
      console.error('Failed to delete account:', error)
      setDeleteAccountError(error instanceof Error ? error.message : 'Failed to delete account.')
    } finally {
      dispatch({ type: 'SET_IS_DELETING_ACCOUNT', payload: false })
    }
  }

  const handleResetLocation = async () => {
    await Promise.all([locationName.reset(), locationLat.reset(), locationLng.reset()])
  }

  const handleResetLocalizationSetting = async (
    settingType: 'distance' | 'temperature' | 'date' | 'time' | 'currency',
  ) => {
    const settingMap = {
      distance: { hook: distanceUnit, dataKey: 'unit' as const },
      temperature: { hook: temperatureUnit, dataKey: 'temperature' as const },
      date: { hook: dateFormat, dataKey: 'dateFormatExample' as const },
      time: { hook: timeFormat, dataKey: 'timeFormat' as const },
      currency: { hook: currency, dataKey: 'currency.code' as const },
    }

    const { hook, dataKey } = settingMap[settingType]

    // If user has a location set, reset to that country's defaults
    if (locationName.value) {
      const country = extractCountryFromLocation(locationName.value)
      if (!country) {
        return
      }

      const countryUnitsData = await fetchCountryUnits(country)
      if (!countryUnitsData) {
        return
      }

      // Get the value from countryUnitsData using the dataKey
      const value = dataKey === 'currency.code' ? countryUnitsData.currency.code : countryUnitsData[dataKey]
      await hook.setValue(value, { recomputeHash: true })
    } else {
      // No location set, fall back to system defaults
      await hook.reset()
    }

    trackEvent('settings_localization_reset')
  }

  // Currency items and display value (memoized for referential stability)
  const currencyItems = useMemo(
    () =>
      (unitsOptionsData?.currencies ?? []).map((c) => ({
        id: c.code,
        label: `${c.name} (${c.symbol})`,
        filterValue: `${c.code} ${c.symbol} ${c.name}`,
      })),
    [unitsOptionsData?.currencies],
  )

  const currencyDisplayValue = useMemo(() => {
    const c = unitsOptionsData?.currencies?.find((c) => c.code === currency.value)
    return c ? `${c.name} (${c.symbol})` : ''
  }, [unitsOptionsData?.currencies, currency.value])

  return (
    <div className="flex flex-col gap-6 p-4 pb-12 w-full max-w-[760px] mx-auto">
      <PageHeader title="Preferences" />

      <SectionCard title="User Experience">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium">Theme</label>
            <ThemeToggle />
          </div>

          <div className="h-px bg-border -mx-6" />

          <div className="flex-row flex items-center gap-4">
            <div className="flex-1">
              <ModificationIndicator
                as="label"
                className="text-sm font-medium"
                hasModifications={hapticsEnabled.isModified}
                onReset={hapticsEnabled.reset}
              >
                Haptic Feedback
              </ModificationIndicator>
              <p className="text-sm text-muted-foreground">Vibrate on tap</p>
            </div>
            <Switch checked={hapticsEnabled.value} onCheckedChange={(value) => hapticsEnabled.setValue(value)} />
          </div>
        </div>
      </SectionCard>

      <div className="h-6" />

      <SectionCard title="Personalization">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <ModificationIndicator
              as="label"
              className="text-sm font-medium"
              hasModifications={preferredName.isModified}
              onReset={async () => {
                await preferredName.reset()
                setNameInput('')
              }}
            >
              Preferred Name
            </ModificationIndicator>
            <Input
              placeholder="Your name"
              className="rounded-lg"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onBlur={async (e) => {
                const value = e.target.value
                const wasSet = !!preferredName.value
                await preferredName.setValue(value || null)
                if (value.trim()) {
                  trackEvent(wasSet ? 'settings_name_update' : 'settings_name_set')
                } else {
                  trackEvent('settings_name_clear')
                }
              }}
            />
            <p className="text-sm text-muted-foreground">How Thunderbolt salutes you</p>
          </div>
        </div>
      </SectionCard>

      <div className="h-6" />

      <SectionCard title="Localization">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <ModificationIndicator
              as="label"
              className="text-sm font-medium"
              hasModifications={locationName.isModified || locationLat.isModified || locationLng.isModified}
              onReset={handleResetLocation}
            >
              Location
            </ModificationIndicator>
            <LocationSearchCombobox value={locationName.value} onSelect={handleSelectLocation} />
            <p className="text-sm text-muted-foreground">Enables location-based responses</p>
          </div>

          <div className="h-px bg-border -mx-6" />

          {/* Distance */}
          <div className="flex flex-row items-center gap-4">
            <div className="flex-1">
              <ModificationIndicator
                as="label"
                className="text-sm font-medium"
                hasModifications={distanceUnit.isModified}
                onReset={() => handleResetLocalizationSetting('distance')}
              >
                Distance
              </ModificationIndicator>
            </div>
            <Select
              value={distanceUnit.value}
              onValueChange={async (v) => {
                await distanceUnit.setValue(v)
                trackEvent('settings_localization_update')
              }}
              disabled={unitsOptionsLoading}
            >
              <SelectTrigger className="w-auto rounded-lg">
                <SelectValue placeholder="Loading..." />
              </SelectTrigger>
              <SelectContent>
                {(unitsOptionsData?.units ?? []).map((u) => (
                  <SelectItem key={u} value={u}>
                    {u.charAt(0).toUpperCase() + u.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Temperature */}
          <div className="flex flex-row items-center gap-4">
            <div className="flex-1">
              <ModificationIndicator
                as="label"
                className="text-sm font-medium"
                hasModifications={temperatureUnit.isModified}
                onReset={() => handleResetLocalizationSetting('temperature')}
              >
                Temperature
              </ModificationIndicator>
            </div>
            <Select
              value={temperatureUnit.value}
              onValueChange={async (v) => {
                await temperatureUnit.setValue(v)
                trackEvent('settings_localization_update')
              }}
              disabled={unitsOptionsLoading}
            >
              <SelectTrigger className="w-auto rounded-lg">
                <SelectValue placeholder="Loading..." />
              </SelectTrigger>
              <SelectContent>
                {(unitsOptionsData?.temperature ?? []).map((t) => (
                  <SelectItem key={t.symbol} value={t.symbol}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Date Format */}
          <div className="flex flex-row items-center gap-4">
            <div className="flex-1">
              <ModificationIndicator
                as="label"
                className="text-sm font-medium"
                hasModifications={dateFormat.isModified}
                onReset={() => handleResetLocalizationSetting('date')}
              >
                Date Format
              </ModificationIndicator>
            </div>
            <Select
              value={dateFormat.value}
              onValueChange={async (v) => {
                await dateFormat.setValue(v)
                trackEvent('settings_localization_update')
              }}
              disabled={unitsOptionsLoading}
            >
              <SelectTrigger className="w-auto rounded-lg">
                <SelectValue placeholder="Loading..." />
              </SelectTrigger>
              <SelectContent>
                {(unitsOptionsData?.dateFormats ?? []).map((f) => (
                  <SelectItem key={f.format} value={f.format}>
                    {f.example}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Time Format */}
          <div className="flex flex-row items-center gap-4">
            <div className="flex-1">
              <ModificationIndicator
                as="label"
                className="text-sm font-medium"
                hasModifications={timeFormat.isModified}
                onReset={() => handleResetLocalizationSetting('time')}
              >
                Time Format
              </ModificationIndicator>
            </div>
            <Select
              value={timeFormat.value}
              onValueChange={async (v) => {
                await timeFormat.setValue(v)
                trackEvent('settings_localization_update')
              }}
              disabled={unitsOptionsLoading}
            >
              <SelectTrigger className="w-auto rounded-lg">
                <SelectValue placeholder="Loading..." />
              </SelectTrigger>
              <SelectContent>
                {(unitsOptionsData?.timeFormat ?? []).map((f) => (
                  <SelectItem key={f} value={f}>
                    {f}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Currency - searchable, uses Combobox */}
          <div className="flex flex-row items-center gap-4">
            <div className="flex-1">
              <ModificationIndicator
                as="label"
                className="text-sm font-medium"
                hasModifications={currency.isModified}
                onReset={() => handleResetLocalizationSetting('currency')}
              >
                Currency
              </ModificationIndicator>
            </div>
            <Combobox
              items={currencyItems}
              value={currency.value}
              onValueChange={async (v) => {
                await currency.setValue(v)
                trackEvent('settings_localization_update')
              }}
              displayValue={currencyDisplayValue || undefined}
              placeholder="Loading..."
              searchPlaceholder="Search currencies..."
              loading={unitsOptionsLoading}
              className="w-auto"
              contentClassName="w-[300px]"
              align="end"
              disabled={unitsOptionsLoading}
            />
          </div>
        </div>
      </SectionCard>

      <div className="h-6" />

      <SectionCard title="Help Thunderbolt Improve">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-4">
            <label className="text-sm font-medium">Preview Features</label>

            <div className="flex-row flex items-center gap-4">
              <div className="flex-1">
                <ModificationIndicator
                  as="label"
                  className="text-sm font-medium"
                  hasModifications={experimentalFeatureTasks.isModified}
                  onReset={experimentalFeatureTasks.reset}
                >
                  Tasks
                </ModificationIndicator>
              </div>
              <Switch checked={experimentalFeatureTasks.value} onCheckedChange={handleExperimentalFeaturesToggle} />
            </div>
          </div>

          <div className="h-px bg-border -mx-6" />

          <div className="flex-row flex items-center gap-4">
            <div>
              <div className="mb-2">
                <ModificationIndicator
                  as="label"
                  className="text-sm font-medium"
                  hasModifications={dataCollection.isModified}
                  onReset={dataCollection.reset}
                >
                  Anonymous Usage Data
                </ModificationIndicator>
              </div>
              <p className="text-sm text-muted-foreground">
                Help us improve the app by sending anonymous usage info such as crashes, performance, and usage. Read
                more about our{' '}
                <a className="text-primary underline-offset-4 hover:underline" href={privacyPolicyUrl} target="_blank">
                  privacy policy
                </a>
                .
              </p>
            </div>
            <Switch checked={dataCollection.value} onCheckedChange={handleDataCollectionToggle} />
          </div>
        </div>
      </SectionCard>

      <div className="h-6" />

      <SectionCard title="Data">
        <div className="flex flex-col gap-6">
          {isAuthenticated ? (
            <div className="flex-row flex items-center gap-4 justify-between">
              <div>
                <label className="text-sm font-medium">Sync This Device With Cloud</label>
              </div>
              <Switch checked={syncEnabled} onCheckedChange={handleSyncToggle} disabled={isConnecting} />
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium">Sync This Device With Cloud</label>
              <Button onClick={openSignInModal}>Sign In</Button>
            </div>
          )}

          {!isAuthenticated && (
            <>
              <div className="h-px bg-border -mx-6" />

              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium">Delete All Local Data</label>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="secondary" disabled={isResetting}>
                      {isResetting ? 'Resetting...' : 'Reset Database'}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Reset Local Database?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This will permanently delete all of your local data including settings, chat history, and cached
                        information. This action cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={handleResetDatabase}
                        className="bg-destructive text-white hover:bg-destructive/90"
                      >
                        Reset Database
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </>
          )}

          {isAuthenticated && (
            <>
              <div className="h-px bg-border -mx-6" />

              <div className="flex flex-col gap-2">
                <p className="text-sm text-muted-foreground">
                  Permanently delete your account and all data on our servers and this device.
                </p>
                {deleteAccountError && (
                  <p className="text-sm text-destructive" role="alert">
                    {deleteAccountError}
                  </p>
                )}
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="destructive" disabled={isDeletingAccount}>
                      {isDeletingAccount ? 'Deleting...' : 'Delete My Account'}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete your account?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This will permanently delete your account and all of your data on our servers and on this
                        device, including settings, chat history, and cached information. This action cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={handleDeleteAccount}
                        className="bg-destructive text-white hover:bg-destructive/90"
                      >
                        Delete account
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </>
          )}
        </div>
      </SectionCard>

      <SyncSetupModal open={syncSetupOpen} onOpenChange={setSyncSetupOpen} onComplete={handleSyncSetupComplete} />

      <TelemetryRequiredModal ref={telemetryRequiredModalRef} onEnableTelemetry={handleEnableTelemetry} />

      <TelemetryWarningModal ref={telemetryWarningModalRef} onDisableTelemetry={handleDisableTelemetry} />

      <AlertDialog open={localizationDialogOpen} onOpenChange={(open) => !open && handleDeclineLocalizationSettings()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Update Defaults?</AlertDialogTitle>
            <AlertDialogDescription>
              Would you like to update your units based on the new location?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep Current Units</AlertDialogCancel>
            <AlertDialogAction autoFocus onClick={handleApplyLocalizationSettings}>
              Update Units
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
