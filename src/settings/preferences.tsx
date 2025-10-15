import { useDebounce } from '@/hooks/use-debounce'
import { useSettings } from '@/hooks/use-settings'
import { cn } from '@/lib/utils'
import ky from 'ky'
import { ChevronsUpDown } from 'lucide-react'
import { useEffect, useReducer, useRef } from 'react'

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
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SectionCard } from '@/components/ui/section-card'

import { Switch } from '@/components/ui/switch'
import { trackEvent } from '@/lib/analytics'
import { getCloudUrl } from '@/lib/config'
import { resetAppDir } from '@/lib/fs'
import { zodResolver } from '@hookform/resolvers/zod'
import { usePostHog } from 'posthog-js/react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

interface LocationData {
  name: string
  city: string
  coordinates: {
    lat: number
    lng: number
  }
}

type PreferencesState = {
  open: boolean
  searchQuery: string
  locations: LocationData[]
  isSearching: boolean
  isResetting: boolean
}

type PreferencesAction =
  | { type: 'SET_OPEN'; payload: boolean }
  | { type: 'SET_SEARCH_QUERY'; payload: string }
  | { type: 'SET_LOCATIONS'; payload: LocationData[] }
  | { type: 'SET_IS_SEARCHING'; payload: boolean }
  | { type: 'SET_IS_RESETTING'; payload: boolean }
  | { type: 'CLEAR_LOCATION_SEARCH' }
  | { type: 'RESET_STATE' }

const initialState: PreferencesState = {
  open: false,
  searchQuery: '',
  locations: [],
  isSearching: false,
  isResetting: false,
}

const preferencesReducer = (state: PreferencesState, action: PreferencesAction): PreferencesState => {
  switch (action.type) {
    case 'SET_OPEN':
      return { ...state, open: action.payload }
    case 'SET_SEARCH_QUERY':
      return { ...state, searchQuery: action.payload }
    case 'SET_LOCATIONS':
      return { ...state, locations: action.payload }
    case 'SET_IS_SEARCHING':
      return { ...state, isSearching: action.payload }
    case 'SET_IS_RESETTING':
      return { ...state, isResetting: action.payload }
    case 'CLEAR_LOCATION_SEARCH':
      return { ...state, searchQuery: '', locations: [] }
    case 'RESET_STATE':
      return initialState
    default:
      return state
  }
}

const nameFormSchema = z.object({
  preferredName: z.string().optional(),
})

const locationFormSchema = z.object({
  locationName: z.string().min(1, { message: 'Location is required.' }),
  locationLat: z.union([z.string().min(1, { message: 'Latitude is required.' }), z.number()]),
  locationLng: z.union([z.string().min(1, { message: 'Longitude is required.' }), z.number()]),
})

export default function PreferencesSettingsPage() {
  const [state, dispatch] = useReducer(preferencesReducer, initialState)
  const { open, searchQuery, locations, isSearching, isResetting } = state

  const telemetryRequiredModalRef = useRef<TelemetryRequiredModalRef>(null)
  const telemetryWarningModalRef = useRef<TelemetryWarningModalRef>(null)

  const postHog = usePostHog()

  const { preferredName, locationName, locationLat, locationLng, dataCollection, experimentalFeatureTasks } =
    useSettings({
      preferred_name: '',
      location_name: '',
      location_lat: '',
      location_lng: '',
      data_collection: true,
      experimental_feature_tasks: false,
    })

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

  const nameForm = useForm<z.infer<typeof nameFormSchema>>({
    resolver: zodResolver(nameFormSchema),
    defaultValues: {
      preferredName: '',
    },
  })

  const locationForm = useForm<z.infer<typeof locationFormSchema>>({
    resolver: zodResolver(locationFormSchema),
    defaultValues: {
      locationName: '',
      locationLat: '',
      locationLng: '',
    },
  })

  // Update forms when data is loaded
  useEffect(() => {
    nameForm.reset({
      preferredName: preferredName.value,
    })
  }, [preferredName.value, nameForm])

  useEffect(() => {
    locationForm.reset({
      locationName: locationName.value,
      locationLat: locationLat.value,
      locationLng: locationLng.value,
    })
  }, [locationName.value, locationLat.value, locationLng.value, locationForm])

  // Debounce the search query
  const debouncedSearchQuery = useDebounce(searchQuery, 300)

  // Search for locations when debounced query changes
  useEffect(() => {
    const searchLocations = async () => {
      // Early return if search query is too short
      if (debouncedSearchQuery.trim().length <= 1) {
        dispatch({ type: 'SET_LOCATIONS', payload: [] })
        return
      }

      dispatch({ type: 'SET_IS_SEARCHING', payload: true })
      try {
        const cloudUrl = await getCloudUrl()

        if (!cloudUrl) {
          console.error('Cloud URL not configured')
          dispatch({ type: 'SET_LOCATIONS', payload: [] })
          return
        }

        const data = await ky
          .get(`${cloudUrl}/locations`, {
            searchParams: { query: debouncedSearchQuery },
          })
          .json<
            Array<{
              name: string
              region: string
              country: string
              lat: number
              lon: number
            }>
          >()
        // Transform the WeatherAPI response to match our LocationData interface
        const transformedLocations: LocationData[] = data.map((location) => ({
          name: `${location.name}, ${location.region}, ${location.country}`,
          city: location.name,
          coordinates: {
            lat: location.lat,
            lng: location.lon,
          },
        }))
        dispatch({ type: 'SET_LOCATIONS', payload: transformedLocations })
      } catch (error) {
        console.error('Error searching locations:', error)
        dispatch({ type: 'SET_LOCATIONS', payload: [] })
      } finally {
        dispatch({ type: 'SET_IS_SEARCHING', payload: false })
      }
    }

    searchLocations()
  }, [debouncedSearchQuery])

  const handleNameBlur = async (value: string) => {
    const wasSet = !!preferredName.value
    await preferredName.setValue(value || null)

    if (value.trim()) {
      if (wasSet) {
        trackEvent('settings_name_update')
      } else {
        trackEvent('settings_name_set')
      }
    } else {
      trackEvent('settings_name_clear')
    }
  }

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

  const handleLocationSave = async (location: LocationData) => {
    // Validate the data before saving
    if (!location.name || location.name.trim() === '') {
      return
    }

    if (typeof location.coordinates.lat !== 'number' || isNaN(location.coordinates.lat)) {
      return
    }

    if (typeof location.coordinates.lng !== 'number' || isNaN(location.coordinates.lng)) {
      return
    }

    const wasSet = !!locationName.value

    await Promise.all([
      locationName.setValue(location.name),
      locationLat.setValue(String(location.coordinates.lat)),
      locationLng.setValue(String(location.coordinates.lng)),
    ])

    if (wasSet) {
      trackEvent('settings_location_update', {
        location_name: location.name,
      })
    } else {
      trackEvent('settings_location_set', {
        location_name: location.name,
      })
    }
  }

  const handleSelectLocation = (location: LocationData) => {
    locationForm.setValue('locationName', location.name)
    locationForm.setValue('locationLat', String(location.coordinates.lat))
    locationForm.setValue('locationLng', String(location.coordinates.lng))
    dispatch({ type: 'SET_OPEN', payload: false })

    // Save immediately after selection, passing the location data directly
    handleLocationSave(location)
  }

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

  const handleResetLocation = async () => {
    await Promise.all([locationName.reset(), locationLat.reset(), locationLng.reset()])
  }

  return (
    <div className="flex flex-col gap-6 p-4 pb-12 w-full max-w-[760px] mx-auto">
      <h1 className="mt-8 text-4xl font-bold tracking-tight mb-2 text-primary">Preferences</h1>

      <SectionCard title="Appearance">
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium">Theme</label>
          <ThemeToggle />
          <p className="text-sm text-muted-foreground">Choose your preferred theme.</p>
        </div>
      </SectionCard>

      <div className="h-6" />

      <SectionCard title="Personal Information">
        <Form {...nameForm}>
          <form className="flex flex-col gap-4" onSubmit={(e) => e.preventDefault()}>
            <FormField
              control={nameForm.control}
              name="preferredName"
              render={({ field }) => (
                <FormItem>
                  <ModificationIndicator
                    as={FormLabel}
                    className="mb-2"
                    hasModifications={preferredName.isModified}
                    onReset={preferredName.reset}
                  >
                    Preferred Name
                  </ModificationIndicator>
                  <FormControl>
                    <Input
                      placeholder="Your name"
                      {...field}
                      onBlur={(e) => {
                        field.onBlur()
                        handleNameBlur(e.target.value)
                      }}
                    />
                  </FormControl>
                  <FormDescription>Your assistant will use this name to address you.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </form>
        </Form>
      </SectionCard>

      <div className="h-6" />

      <SectionCard title="Location">
        <Form {...locationForm}>
          <form className="flex flex-col gap-4" onSubmit={(e) => e.preventDefault()}>
            <FormField
              control={locationForm.control}
              name="locationName"
              render={({ field }) => (
                <FormItem className="flex flex-col">
                  <ModificationIndicator
                    as={FormLabel}
                    className="mb-2"
                    hasModifications={locationName.isModified || locationLat.isModified || locationLng.isModified}
                    onReset={handleResetLocation}
                  >
                    Location
                  </ModificationIndicator>
                  <Popover
                    open={open}
                    onOpenChange={(newOpen) => {
                      dispatch({ type: 'SET_OPEN', payload: newOpen })
                      if (!newOpen) {
                        // Clear search when closing
                        dispatch({ type: 'CLEAR_LOCATION_SEARCH' })
                      }
                    }}
                  >
                    <PopoverTrigger asChild>
                      <FormControl>
                        <Button
                          variant="outline"
                          role="combobox"
                          aria-expanded={open}
                          className={cn('w-full justify-between', !field.value && 'text-muted-foreground')}
                        >
                          {field.value || 'Select location...'}
                          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                        </Button>
                      </FormControl>
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
                          value={searchQuery}
                          onValueChange={(value) => dispatch({ type: 'SET_SEARCH_QUERY', payload: value })}
                        />
                        <CommandList>
                          {searchQuery.trim().length > 0 && isSearching && (
                            <div className="py-6 text-center text-sm">
                              <div className="inline-flex items-center gap-2">
                                <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" />
                                Searching...
                              </div>
                            </div>
                          )}
                          {searchQuery.trim().length > 0 && !isSearching && locations.length === 0 && (
                            <CommandEmpty>No locations found.</CommandEmpty>
                          )}
                          {!isSearching && locations.length > 0 && (
                            <CommandGroup>
                              {locations.map((location) => (
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
                  <FormDescription>Select your location to enable location-based features.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </form>
        </Form>
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
              <a
                className="text-primary underline-offset-4 hover:underline"
                href="https://www.thunderbird.net/en-US/privacy/"
                target="_blank"
              >
                privacy policy
              </a>
              .
            </p>
          </div>
          <Switch checked={dataCollection.value} onCheckedChange={handleDataCollectionToggle} />
        </div>
      </SectionCard>

      <div className="h-6" />

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

      <TelemetryRequiredModal ref={telemetryRequiredModalRef} onEnableTelemetry={handleEnableTelemetry} />

      <TelemetryWarningModal ref={telemetryWarningModalRef} onDisableTelemetry={handleDisableTelemetry} />
    </div>
  )
}
