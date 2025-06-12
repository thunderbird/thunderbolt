import { useDrizzle } from '@/db/provider'
import { settingsTable } from '@/db/tables'
import { useDebounce } from '@/hooks/use-debounce'
import { cn } from '@/lib/utils'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { eq } from 'drizzle-orm'
import ky from 'ky'
import { ChevronsUpDown } from 'lucide-react'
import React from 'react'

import { ThemeToggle } from '@/components/theme-toggle'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SectionCard } from '@/components/ui/section-card'

import { zodResolver } from '@hookform/resolvers/zod'
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

const nameFormSchema = z.object({
  preferredName: z.string().optional(),
})

const locationFormSchema = z.object({
  locationName: z.string().min(1, { message: 'Location is required.' }),
  locationLat: z.union([z.string().min(1, { message: 'Latitude is required.' }), z.number()]),
  locationLng: z.union([z.string().min(1, { message: 'Longitude is required.' }), z.number()]),
})

export default function PreferencesSettingsPage() {
  const { db } = useDrizzle()
  const queryClient = useQueryClient()
  const [open, setOpen] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState('')
  const [locations, setLocations] = React.useState<LocationData[]>([])
  const [isSearching, setIsSearching] = React.useState(false)

  // Get any existing settings from the database
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const nameData = await db.select().from(settingsTable).where(eq(settingsTable.key, 'location_name'))
      const latData = await db.select().from(settingsTable).where(eq(settingsTable.key, 'location_lat'))
      const lngData = await db.select().from(settingsTable).where(eq(settingsTable.key, 'location_lng'))
      const preferredNameData = await db.select().from(settingsTable).where(eq(settingsTable.key, 'preferred_name'))

      return {
        locationName: nameData[0]?.value || '',
        locationLat: latData[0]?.value || '',
        locationLng: lngData[0]?.value || '',
        preferredName: preferredNameData[0]?.value || '',
      }
    },
  })

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
  React.useEffect(() => {
    if (settings) {
      nameForm.reset({
        preferredName: settings.preferredName as string,
      })

      locationForm.reset({
        locationName: settings.locationName as string,
        locationLat: typeof settings.locationLat === 'string' ? settings.locationLat : String(settings.locationLat || ''),
        locationLng: typeof settings.locationLng === 'string' ? settings.locationLng : String(settings.locationLng || ''),
      })
    }
  }, [settings, nameForm, locationForm])

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
          .values({ key: 'location_lat', value: values.locationLat })
          .onConflictDoUpdate({
            target: settingsTable.key,
            set: { value: values.locationLat },
          })

        await db
          .insert(settingsTable)
          .values({ key: 'location_lng', value: values.locationLng })
          .onConflictDoUpdate({
            target: settingsTable.key,
            set: { value: values.locationLng },
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

  return (
    <div className="flex flex-col gap-6 p-4 w-full max-w-[760px] mx-auto">
      <h1 className="text-4xl font-bold tracking-tight mb-2 text-primary">Preferences</h1>

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
                        <Button variant="outline" role="combobox" aria-expanded={open} className={cn('w-full justify-between', !field.value && 'text-muted-foreground')}>
                          {field.value || 'Select location...'}
                          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                        </Button>
                      </FormControl>
                    </PopoverTrigger>
                    <PopoverContent className="p-0 w-[--radix-popover-trigger-width]" side="bottom" align="start" sideOffset={4}>
                      <Command>
                        <CommandInput placeholder="Search for locations..." value={searchQuery} onValueChange={setSearchQuery} />
                        <CommandList>
                          {searchQuery.trim().length > 0 && isSearching && (
                            <div className="py-6 text-center text-sm">
                              <div className="inline-flex items-center gap-2">
                                <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" />
                                Searching...
                              </div>
                            </div>
                          )}
                          {searchQuery.trim().length > 0 && !isSearching && locations.length === 0 && <CommandEmpty>No locations found.</CommandEmpty>}
                          {!isSearching && locations.length > 0 && (
                            <CommandGroup>
                              {locations.map((location) => (
                                <CommandItem key={`${location.coordinates.lat}-${location.coordinates.lng}`} value={location.name} onSelect={() => handleSelectLocation(location)} className="pl-2">
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
    </div>
  )
}
