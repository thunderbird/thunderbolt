import { useAuth } from '@/contexts'
import { useCountryUnits } from '@/hooks/use-country-units'
import { useLocationSearch, type LocationData } from '@/hooks/use-location-search'
import { useLocalizationDropdowns } from '@/hooks/use-localization-dropdowns'
import { useSettings } from '@/hooks/use-settings'
import { useUnitsOptions } from '@/hooks/use-units-options'
import { privacyPolicyUrl } from '@/lib/constants'
import { extractCountryFromLocation } from '@/lib/country-utils'
import { getAuthToken, clearAuthToken } from '@/lib/auth-token'
import { trackEvent } from '@/lib/posthog'
import { cn } from '@/lib/utils'
import type { CountryUnitsData } from '@/types'
import { ChevronsUpDown } from 'lucide-react'
import ky from 'ky'
import { useEffect, useReducer, useRef, useState } from 'react'

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
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/page-header'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SectionCard } from '@/components/ui/section-card'
import { Switch } from '@/components/ui/switch'
import { resetAppDir } from '@/lib/fs'
import { usePostHog } from 'posthog-js/react'
import { isSyncEnabled, setSyncEnabled, SYNC_ENABLED_CHANGE_EVENT } from '@/db/powersync'

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
  const locationSearch = useLocationSearch()
  const authClient = useAuth()
  const { data: session } = authClient.useSession()
  const isAuthenticated = !!session?.user

  const { fetchCountryUnits } = useCountryUnits()

  // Localization dropdown states
  const {
    distanceDropdownOpen,
    temperatureDropdownOpen,
    dateFormatDropdownOpen,
    timeFormatDropdownOpen,
    currencyDropdownOpen,
    setDistanceDropdownOpen,
    setTemperatureDropdownOpen,
    setDateFormatDropdownOpen,
    setTimeFormatDropdownOpen,
    setCurrencyDropdownOpen,
  } = useLocalizationDropdowns()

  const telemetryRequiredModalRef = useRef<TelemetryRequiredModalRef>(null)
  const telemetryWarningModalRef = useRef<TelemetryWarningModalRef>(null)

  const postHog = usePostHog()

  // Local state for name input (only save on blur to avoid DB writes on every keystroke)
  const [nameInput, setNameInput] = useState('')

  // Local state for sync enabled (PowerSync)
  const [syncEnabled, setSyncEnabledState] = useState(isSyncEnabled())
  const [syncEnableWarningOpen, setSyncEnableWarningOpen] = useState(false)

  // Use our useSettings hook for all settings
  const {
    preferredName,
    locationName,
    locationLat,
    locationLng,
    dataCollection,
    experimentalFeatureTasks,
    distanceUnit,
    temperatureUnit,
    dateFormat,
    timeFormat,
    currency,
    cloudUrl,
  } = useSettings({
    preferred_name: '',
    location_name: '',
    location_lat: '',
    location_lng: '',
    data_collection: true,
    experimental_feature_tasks: false,
    distance_unit: 'imperial',
    temperature_unit: 'f',
    date_format: 'MM/DD/YYYY',
    time_format: '12h',
    currency: 'USD',
    cloud_url: 'http://localhost:8000/v1',
  })

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

  // Sync local name input with settings value
  useEffect(() => {
    setNameInput(preferredName.value || '')
  }, [preferredName.value])

  // Listen for external sync enabled changes
  useEffect(() => {
    const handleSyncEnabledChange = (event: Event) => {
      const customEvent = event as CustomEvent<boolean>
      setSyncEnabledState(customEvent.detail)
    }

    window.addEventListener(SYNC_ENABLED_CHANGE_EVENT, handleSyncEnabledChange)
    return () => window.removeEventListener(SYNC_ENABLED_CHANGE_EVENT, handleSyncEnabledChange)
  }, [])

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

    locationSearch.setOpen(false)

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
    if (!pendingCountryUnits) return

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
      await resetAppDir()
      trackEvent('settings_database_reset')
      // Refresh the page to reinitialize the app
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
      await setSyncEnabled(false)
      const token = getAuthToken()
      if (!token) {
        setDeleteAccountError('Not signed in.')
        return
      }
      const baseUrl = cloudUrl.value ?? 'http://localhost:8000/v1'
      await ky.delete('account', {
        prefixUrl: baseUrl,
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'omit',
      })
      await clearAuthToken()
      await resetAppDir()
      window.location.reload()
    } catch (error) {
      console.error('Failed to delete account:', error)
      setDeleteAccountError(error instanceof Error ? error.message : 'Failed to delete account.')
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
      if (!country) return

      const countryUnitsData = await fetchCountryUnits(country)
      if (!countryUnitsData) return

      // Get the value from countryUnitsData using the dataKey
      const value = dataKey === 'currency.code' ? countryUnitsData.currency.code : countryUnitsData[dataKey]
      await hook.setValue(value, { recomputeHash: true })
    } else {
      // No location set, fall back to system defaults
      await hook.reset()
    }

    trackEvent('settings_localization_reset')
  }

  const handleSyncToggle = async (enabled: boolean) => {
    if (!enabled) {
      await setSyncEnabled(false)
      setSyncEnabledState(false)
      trackEvent('settings_sync_disabled')
      return
    }
    setSyncEnableWarningOpen(true)
  }

  const handleConfirmEnableSync = async () => {
    await setSyncEnabled(true)
    setSyncEnabledState(true)
    trackEvent('settings_sync_enabled')
    setSyncEnableWarningOpen(false)
  }

  return (
    <div className="flex flex-col gap-6 p-4 pb-12 w-full max-w-[760px] mx-auto">
      <PageHeader title="Preferences" />

      <SectionCard title="Appearance">
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium">Theme</label>
          <ThemeToggle />
          <p className="text-sm text-muted-foreground">Choose your preferred theme.</p>
        </div>
      </SectionCard>

      <div className="h-6" />

      <SectionCard title="Personal Information">
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
            <p className="text-sm text-muted-foreground">Your assistant will use this name to address you.</p>
          </div>
        </div>
      </SectionCard>

      <div className="h-6" />

      <SectionCard title="Location">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <ModificationIndicator
              as="label"
              className="text-sm font-medium"
              hasModifications={locationName.isModified || locationLat.isModified || locationLng.isModified}
              onReset={handleResetLocation}
            >
              Location
            </ModificationIndicator>
            <Popover
              open={locationSearch.open}
              onOpenChange={(newOpen) => {
                locationSearch.setOpen(newOpen)
                if (!newOpen) {
                  locationSearch.clearSearch()
                }
              }}
            >
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={locationSearch.open}
                  className={cn('w-full justify-between', !locationName.value && 'text-muted-foreground')}
                >
                  {locationName.value || 'Select location...'}
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                className="p-0 w-[--radix-popover-trigger-width]"
                side="bottom"
                align="start"
                sideOffset={4}
              >
                <Command>
                  <CommandInput
                    placeholder="Search for locations..."
                    value={locationSearch.searchQuery}
                    onValueChange={locationSearch.setSearchQuery}
                  />
                  <CommandList>
                    {locationSearch.searchQuery.trim().length > 0 && locationSearch.isSearching && (
                      <div className="py-6 text-center text-sm">
                        <div className="inline-flex items-center gap-2">
                          <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" />
                          Searching...
                        </div>
                      </div>
                    )}
                    {locationSearch.searchQuery.trim().length > 0 &&
                      !locationSearch.isSearching &&
                      locationSearch.locations.length === 0 && <CommandEmpty>No locations found.</CommandEmpty>}
                    {!locationSearch.isSearching && locationSearch.locations.length > 0 && (
                      <CommandGroup>
                        {locationSearch.locations.map((location) => (
                          <CommandItem
                            key={`${location.coordinates.lat}-${location.coordinates.lng}`}
                            value={location.name}
                            onSelect={() => handleSelectLocation(location)}
                            className="pl-2"
                          >
                            {location.name}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    )}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            <p className="text-sm text-muted-foreground">Select your location to enable location-based features.</p>
          </div>
        </div>
      </SectionCard>

      <div className="h-6" />

      <SectionCard title="Localization">
        <div className="flex flex-col gap-4">
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
            <Popover open={distanceDropdownOpen} onOpenChange={setDistanceDropdownOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  disabled={unitsOptionsLoading}
                  className={cn('w-auto justify-between', !distanceUnit.value && 'text-muted-foreground')}
                >
                  {unitsOptionsLoading
                    ? 'Loading...'
                    : distanceUnit.value
                      ? distanceUnit.value.charAt(0).toUpperCase() + distanceUnit.value.slice(1)
                      : 'Loading...'}
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="p-0 w-auto">
                <Command>
                  <CommandList>
                    <CommandGroup>
                      {unitsOptionsData?.units?.map((unit) => (
                        <CommandItem
                          key={unit}
                          value={unit}
                          onSelect={async () => {
                            await distanceUnit.setValue(unit)
                            trackEvent('settings_localization_update')
                            setDistanceDropdownOpen(false)
                          }}
                        >
                          {unit.charAt(0).toUpperCase() + unit.slice(1)}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>

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
            <Popover open={temperatureDropdownOpen} onOpenChange={setTemperatureDropdownOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  disabled={unitsOptionsLoading}
                  className={cn('w-auto justify-between', !temperatureUnit.value && 'text-muted-foreground')}
                >
                  {unitsOptionsLoading
                    ? 'Loading...'
                    : unitsOptionsData?.temperature?.find((temp) => temp.symbol === temperatureUnit.value)?.name ||
                      temperatureUnit.value ||
                      'Loading...'}
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="p-0 w-auto">
                <Command>
                  <CommandList>
                    <CommandGroup>
                      {unitsOptionsData?.temperature?.map((temp) => (
                        <CommandItem
                          key={temp.symbol}
                          value={temp.symbol}
                          onSelect={async () => {
                            await temperatureUnit.setValue(temp.symbol)
                            trackEvent('settings_localization_update')
                            setTemperatureDropdownOpen(false)
                          }}
                        >
                          {temp.name}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>

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
            <Popover open={dateFormatDropdownOpen} onOpenChange={setDateFormatDropdownOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  disabled={unitsOptionsLoading}
                  className={cn('w-auto justify-between', !dateFormat.value && 'text-muted-foreground')}
                >
                  {unitsOptionsLoading
                    ? 'Loading...'
                    : dateFormat.value
                      ? unitsOptionsData?.dateFormats?.find((f) => f.format === dateFormat.value)?.example ||
                        dateFormat.value
                      : 'Loading...'}
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="p-0 w-auto">
                <Command>
                  <CommandList>
                    <CommandGroup>
                      {unitsOptionsData?.dateFormats?.map((format) => (
                        <CommandItem
                          key={format.format}
                          value={format.example}
                          onSelect={async () => {
                            await dateFormat.setValue(format.format)
                            trackEvent('settings_localization_update')
                            setDateFormatDropdownOpen(false)
                          }}
                        >
                          {format.example}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>

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
            <Popover open={timeFormatDropdownOpen} onOpenChange={setTimeFormatDropdownOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  disabled={unitsOptionsLoading}
                  className={cn('w-auto justify-between', !timeFormat.value && 'text-muted-foreground')}
                >
                  {unitsOptionsLoading ? 'Loading...' : timeFormat.value || 'Loading...'}
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="p-0 w-auto">
                <Command>
                  <CommandList>
                    <CommandGroup>
                      {unitsOptionsData?.timeFormat?.map((format) => (
                        <CommandItem
                          key={format}
                          value={format}
                          onSelect={async () => {
                            await timeFormat.setValue(format)
                            trackEvent('settings_localization_update')
                            setTimeFormatDropdownOpen(false)
                          }}
                        >
                          {format}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>

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
            <Popover open={currencyDropdownOpen} onOpenChange={setCurrencyDropdownOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  disabled={unitsOptionsLoading}
                  className={cn('w-auto justify-between', !currency.value && 'text-muted-foreground')}
                >
                  {unitsOptionsLoading
                    ? 'Loading...'
                    : (() => {
                        const selectedCurrency = unitsOptionsData?.currencies?.find((c) => c.code === currency.value)
                        return selectedCurrency ? `${selectedCurrency.name} (${selectedCurrency.symbol})` : 'Loading...'
                      })()}
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="p-0 w-[300px]">
                <Command>
                  <CommandInput placeholder="Search currency by code, symbol, or name..." />
                  <CommandList>
                    <CommandGroup>
                      {unitsOptionsData?.currencies?.map((currencyOption) => (
                        <CommandItem
                          key={currencyOption.code}
                          value={`${currencyOption.code} ${currencyOption.symbol} ${currencyOption.name}`}
                          onSelect={async () => {
                            await currency.setValue(currencyOption.code)
                            trackEvent('settings_localization_update')
                            setCurrencyDropdownOpen(false)
                          }}
                        >
                          {currencyOption.name} ({currencyOption.symbol})
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </SectionCard>

      <div className="h-6" />

      <SectionCard title="Preview Features">
        <p className="mb-4 text-sm text-muted-foreground">Try out experimental beta features.</p>

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
      </SectionCard>

      <div className="h-6" />

      <SectionCard title="Privacy">
        <div className="flex-row flex items-center gap-4">
          <div>
            <div className="mb-2">
              <ModificationIndicator
                as="label"
                className="text-sm font-medium"
                hasModifications={dataCollection.isModified}
                onReset={dataCollection.reset}
              >
                Data Collection
              </ModificationIndicator>
            </div>
            <p className="text-sm text-muted-foreground">
              Help us improve the app by sending anonymous usage info such as crashes, performance, and usage. No
              personal data is collected or stored. Read more about our{' '}
              <a className="text-primary underline-offset-4 hover:underline" href={privacyPolicyUrl} target="_blank">
                privacy policy
              </a>
              .
            </p>
          </div>
          <Switch checked={dataCollection.value} onCheckedChange={handleDataCollectionToggle} />
        </div>
      </SectionCard>

      <div className="h-6" />

      <SectionCard title="Sync">
        <div className="flex-row flex items-center gap-4">
          <div>
            <div className="mb-2">
              <label className="text-sm font-medium">Cloud Sync</label>
            </div>
            <p className="text-sm text-muted-foreground">
              Enable cloud synchronization to keep your data synced across devices. Your data is encrypted and securely
              stored.
            </p>
          </div>
          <Switch checked={syncEnabled} onCheckedChange={handleSyncToggle} />
        </div>
      </SectionCard>

      <AlertDialog open={syncEnableWarningOpen} onOpenChange={(open) => !open && setSyncEnableWarningOpen(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enable sync?</AlertDialogTitle>
            <AlertDialogDescription>
              At this time, synced data is not encrypted. Enabling sync will store your data on our servers without
              encryption. Do you want to continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmEnableSync}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              Enable sync without encryption
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="h-6" />

      {!isAuthenticated && (
        <SectionCard title="Local Database">
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">Delete all of your local data.</p>
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
        </SectionCard>
      )}

      {isAuthenticated && (
        <SectionCard title="Account">
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">
              Permanently delete your account and all data on our servers and this device. This action cannot be undone.
            </p>
            {deleteAccountError && (
              <p className="text-sm text-destructive" role="alert">
                {deleteAccountError}
              </p>
            )}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" disabled={isDeletingAccount}>
                  {isDeletingAccount ? 'Deleting...' : 'Delete my account'}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete your account?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently delete your account and all of your data on our servers and on this device,
                    including settings, chat history, and cached information. This action cannot be undone.
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
        </SectionCard>
      )}

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
