import { settingsTable } from '@/db/tables'
import { useDebounce } from '@/hooks/use-debounce'
import { cn } from '@/lib/utils'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { eq } from 'drizzle-orm'
import ky from 'ky'
import { ChevronsUpDown } from 'lucide-react'
import React from 'react'

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

import { useDatabase } from '@/hooks/use-database'
import { resetAppDir } from '@/lib/fs'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { Switch } from '@/components/ui/switch'
import { usePostHog } from 'posthog-js/react'

interface LocationData {
  name: string
  city: string
  coordinates: {
    lat: number
    lng: number
  }
}

const nameFormSchema = z.object({
  preferredName: z.string().optional(),
})

const privacyFormSchema = z.object({
  dataCollection: z.boolean(),
})

const locationFormSchema = z.object({
  locationName: z.string().min(1, { message: 'Location is required.' }),
  locationLat: z.union([z.string().min(1, { message: 'Latitude is required.' }), z.number()]),
  locationLng: z.union([z.string().min(1, { message: 'Longitude is required.' }), z.number()]),
})

export default function PreferencesSettingsPage() {
  const { db } = useDatabase()
  const queryClient = useQueryClient()
  const [open, setOpen] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState('')
  const [locations, setLocations] = React.useState<LocationData[]>([])
  const [isSearching, setIsSearching] = React.useState(false)
  const [isResetting, setIsResetting] = React.useState(false)

  const postHog = usePostHog()

  // Get any existing settings from the database
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const nameData = await db.select().from(settingsTable).where(eq(settingsTable.key, 'location_name'))
      const latData = await db.select().from(settingsTable).where(eq(settingsTable.key, 'location_lat'))
      const lngData = await db.select().from(settingsTable).where(eq(settingsTable.key, 'location_lng'))
      const preferredNameData = await db.select().from(settingsTable).where(eq(settingsTable.key, 'preferred_name'))
      const dataCollection = await db.select().from(settingsTable).where(eq(settingsTable.key, 'data_collection'))

      return {
        locationName: nameData[0]?.value || '',
        locationLat: latData[0]?.value || '',
        locationLng: lngData[0]?.value || '',
        preferredName: preferredNameData[0]?.value || '',
        dataCollection: dataCollection[0]?.value === 'false' ? false : true,
      }
    },
  })

  const nameForm = useForm<z.infer<typeof nameFormSchema>>({
    resolver: zodResolver(nameFormSchema),
    defaultValues: {
      preferredName: '',
    },
  })

  const privacyForm = useForm<z.infer<typeof privacyFormSchema>>({
    resolver: zodResolver(privacyFormSchema),
    defaultValues: {
      dataCollection: true,
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
  React.useEffect(() => {
    if (settings) {
      nameForm.reset({
        preferredName: settings.preferredName as string,
      })

      privacyForm.reset({
        dataCollection: settings.dataCollection,
      })

      locationForm.reset({
        locationName: settings.locationName as string,
        locationLat:
          typeof settings.locationLat === 'string' ? settings.locationLat : String(settings.locationLat || ''),
        locationLng:
          typeof settings.locationLng === 'string' ? settings.locationLng : String(settings.locationLng || ''),
      })
    }
  }, [settings, nameForm, locationForm, privacyForm])

  // Debounce the search query
  const debouncedSearchQuery = useDebounce(searchQuery, 300)

  // Search for locations when debounced query changes
  React.useEffect(() => {
    const searchLocations = async () => {
      // Early return if search query is too short
      if (debouncedSearchQuery.trim().length <= 1) {
        setLocations([])
        return
      }

      setIsSearching(true)
      try {
        // Get cloud_url from database settings
        const cloudUrlData = await db.select().from(settingsTable).where(eq(settingsTable.key, 'cloud_url'))
        const cloudUrl = cloudUrlData[0]?.value

        if (!cloudUrl) {
          console.error('Cloud URL not configured')
          setLocations([])
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
        setLocations(transformedLocations)
      } catch (error) {
        console.error('Error searching locations:', error)
        setLocations([])
      } finally {
        setIsSearching(false)
      }
    }

    searchLocations()
  }, [debouncedSearchQuery, db])

  // Save name mutation
  const saveNameMutation = useMutation({
    mutationFn: async (values: z.infer<typeof nameFormSchema>) => {
      // Upsert the setting
      await db
        .insert(settingsTable)
        .values({ key: 'preferred_name', value: values.preferredName })
        .onConflictDoUpdate({
          target: settingsTable.key,
          set: { value: values.preferredName },
        })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
  })

  // Save data collection mutation
  const saveDataCollectionMutation = useMutation({
    mutationFn: async (values: z.infer<typeof privacyFormSchema>) => {
      // Upsert the setting
      await db
        .insert(settingsTable)
        .values({ key: 'data_collection', value: values.dataCollection ? 'true' : 'false' })
        .onConflictDoUpdate({
          target: settingsTable.key,
          set: { value: values.dataCollection ? 'true' : 'false' },
        })
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['settings'] })

      variables.dataCollection ? postHog.opt_in_capturing() : postHog.opt_out_capturing()
    },
  })

  // Save location mutation
  const saveLocationMutation = useMutation({
    mutationFn: async (values: z.infer<typeof locationFormSchema>) => {
      try {
        // Save each setting sequentially with individual error handling
        await db
          .insert(settingsTable)
          .values({ key: 'location_name', value: values.locationName })
          .onConflictDoUpdate({
            target: settingsTable.key,
            set: { value: values.locationName },
          })

        await db
          .insert(settingsTable)
          .values({ key: 'location_lat', value: values.locationLat.toString() })
          .onConflictDoUpdate({
            target: settingsTable.key,
            set: { value: values.locationLat.toString() },
          })

        await db
          .insert(settingsTable)
          .values({ key: 'location_lng', value: values.locationLng.toString() })
          .onConflictDoUpdate({
            target: settingsTable.key,
            set: { value: values.locationLng.toString() },
          })
      } catch (error) {
        console.error('Error saving location settings:', error)
        throw error
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
  })

  const handleNameBlur = async (value: string) => {
    // Save the value directly
    await saveNameMutation.mutateAsync({ preferredName: value })
  }

  const handleDataCollectionToggle = async (value: boolean) => {
    await saveDataCollectionMutation.mutateAsync({ dataCollection: value })
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

    const values = {
      locationName: location.name,
      locationLat: location.coordinates.lat,
      locationLng: location.coordinates.lng,
    }

    await saveLocationMutation.mutateAsync(values)
  }

  const handleSelectLocation = (location: LocationData) => {
    locationForm.setValue('locationName', location.name)
    locationForm.setValue('locationLat', String(location.coordinates.lat))
    locationForm.setValue('locationLng', String(location.coordinates.lng))
    setOpen(false)
    // Save immediately after selection, passing the location data directly
    handleLocationSave(location)
  }

  const handleResetDatabase = async () => {
    setIsResetting(true)
    try {
      await resetAppDir()
      // Refresh the page to reinitialize the app
      window.location.reload()
    } catch (error) {
      console.error('Failed to reset database:', error)
      setIsResetting(false)
    }
  }

  return (
    <div className="flex flex-col gap-6 p-4 w-full max-w-[760px] mx-auto">
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
                  <FormLabel>Preferred Name</FormLabel>
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
                  <FormLabel>Location</FormLabel>
                  <Popover
                    open={open}
                    onOpenChange={(newOpen) => {
                      setOpen(newOpen)
                      if (!newOpen) {
                        // Clear search when closing
                        setSearchQuery('')
                        setLocations([])
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
                          onValueChange={setSearchQuery}
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

      <SectionCard title="Privacy">
        <Form {...privacyForm}>
          <form className="flex flex-col gap-2" onSubmit={(e) => e.preventDefault()}>
            <FormField
              control={privacyForm.control}
              name="dataCollection"
              render={({ field }) => (
                <div className="flex-row flex items-center gap-4">
                  <div>
                    <label className="text-sm font-medium">Data Collection</label>
                    <p className="text-sm text-muted-foreground">
                      Help us improve the app by sending anonymous usage info such as crashes, performance, and usage.
                      No personal data is collected or stored. Read more about our{' '}
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
                  <Switch checked={field.value} onCheckedChange={handleDataCollectionToggle} />
                </div>
              )}
            />
          </form>
        </Form>
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
    </div>
  )
}
