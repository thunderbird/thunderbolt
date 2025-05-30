import { useDrizzle } from '@/db/provider'
import { settingsTable } from '@/db/tables'
import { cn } from '@/lib/utils'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { eq, sql } from 'drizzle-orm'
import { Check, ChevronsUpDown } from 'lucide-react'
import React from 'react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem } from '@/components/ui/command'
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

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
  locationLat: z.string().min(1, { message: 'Latitude is required.' }),
  locationLng: z.string().min(1, { message: 'Longitude is required.' }),
})

const cloudFormSchema = z.object({
  cloudUrl: z.string().url({ message: 'Please enter a valid URL.' }).or(z.string().length(0)),
})

export default function PreferencesSettingsPage() {
  const { db } = useDrizzle()
  const queryClient = useQueryClient()
  const [open, setOpen] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState('')
  const [locations, setLocations] = React.useState<LocationData[]>([])
  const [isSearching, setIsSearching] = React.useState(false)
  const [showNameSaved, setShowNameSaved] = React.useState(false)
  const [showLocationSaved, setShowLocationSaved] = React.useState(false)
  const [showCloudSaved, setShowCloudSaved] = React.useState(false)

  // Get any existing settings from the database
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const nameData = await db.select().from(settingsTable).where(eq(settingsTable.key, 'location_name'))
      const latData = await db.select().from(settingsTable).where(eq(settingsTable.key, 'location_lat'))
      const lngData = await db.select().from(settingsTable).where(eq(settingsTable.key, 'location_lng'))
      const preferredNameData = await db.select().from(settingsTable).where(eq(settingsTable.key, 'preferred_name'))
      const cloudUrlData = await db.select().from(settingsTable).where(eq(settingsTable.key, 'cloud_url'))

      return {
        locationName: nameData[0]?.value || '',
        locationLat: latData[0]?.value || '',
        locationLng: lngData[0]?.value || '',
        preferredName: preferredNameData[0]?.value || '',
        cloudUrl: cloudUrlData[0]?.value || '',
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

  const cloudForm = useForm<z.infer<typeof cloudFormSchema>>({
    resolver: zodResolver(cloudFormSchema),
    defaultValues: {
      cloudUrl: '',
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
        locationLat: settings.locationLat as string,
        locationLng: settings.locationLng as string,
      })

      cloudForm.reset({
        cloudUrl: settings.cloudUrl as string,
      })
    }
  }, [settings, nameForm, locationForm, cloudForm])

  // Debounced search for locations
  React.useEffect(() => {
    const searchTimeout = setTimeout(async () => {
      if (searchQuery.trim().length > 1 && settings?.cloudUrl) {
        setIsSearching(true)
        try {
          // Use cloud_url from database settings as base URL
          const baseUrl = settings.cloudUrl as string
          const response = await fetch(`${baseUrl}/locations?query=${encodeURIComponent(searchQuery)}`)

          if (response.ok) {
            const data = await response.json()
            // Transform the WeatherAPI response to match our LocationData interface
            const transformedLocations: LocationData[] = data.map((location: any) => ({
              name: `${location.name}, ${location.region}, ${location.country}`,
              city: location.name,
              coordinates: {
                lat: location.lat,
                lng: location.lon,
              },
            }))
            setLocations(transformedLocations)
          } else {
            console.error('Error searching locations:', response.statusText)
            setLocations([])
          }
        } catch (error) {
          console.error('Error searching locations:', error)
          setLocations([])
        } finally {
          setIsSearching(false)
        }
      } else {
        setLocations([])
      }
    }, 300)

    return () => clearTimeout(searchTimeout)
  }, [searchQuery, settings?.cloudUrl])

  // Save name mutation
  const saveNameMutation = useMutation({
    mutationFn: async (values: z.infer<typeof nameFormSchema>) => {
      // Delete and insert for this specific setting
      await db.delete(settingsTable).where(eq(settingsTable.key, 'preferred_name'))
      await db.insert(settingsTable).values([{ key: 'preferred_name', value: values.preferredName }])
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] })
      setShowNameSaved(true)
      setTimeout(() => setShowNameSaved(false), 2000)
    },
  })

  // Save location mutation
  const saveLocationMutation = useMutation({
    mutationFn: async (values: z.infer<typeof locationFormSchema>) => {
      // Delete and insert for location settings
      await db.delete(settingsTable).where(sql`${settingsTable.key} IN ('location_name', 'location_lat', 'location_lng')`)
      await db.insert(settingsTable).values([
        { key: 'location_name', value: values.locationName },
        { key: 'location_lat', value: values.locationLat },
        { key: 'location_lng', value: values.locationLng },
      ])
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] })
      setShowLocationSaved(true)
      setTimeout(() => setShowLocationSaved(false), 2000)
    },
  })

  // Save cloud provider mutation
  const saveCloudMutation = useMutation({
    mutationFn: async (values: z.infer<typeof cloudFormSchema>) => {
      // Delete and insert for cloud url setting
      await db.delete(settingsTable).where(eq(settingsTable.key, 'cloud_url'))
      await db.insert(settingsTable).values([{ key: 'cloud_url', value: values.cloudUrl }])
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] })
      setShowCloudSaved(true)
      setTimeout(() => setShowCloudSaved(false), 2000)
    },
  })

  const onSubmitName = async (values: z.infer<typeof nameFormSchema>) => {
    setShowNameSaved(false)
    await saveNameMutation.mutateAsync(values)
  }

  const onSubmitLocation = async (values: z.infer<typeof locationFormSchema>) => {
    setShowLocationSaved(false)
    await saveLocationMutation.mutateAsync(values)
  }

  const onSubmitCloud = async (values: z.infer<typeof cloudFormSchema>) => {
    setShowCloudSaved(false)
    await saveCloudMutation.mutateAsync(values)
  }

  const handleSelectLocation = (location: LocationData) => {
    locationForm.setValue('locationName', location.name)
    locationForm.setValue('locationLat', String(location.coordinates.lat))
    locationForm.setValue('locationLng', String(location.coordinates.lng))
    setOpen(false)
  }

  return (
    <div className="flex flex-col gap-4 p-4 w-full max-w-[760px] mx-auto">
      <h1 className="text-4xl font-bold tracking-tight mb-2 text-primary">Preferences</h1>

      <h3 className="text-lg font-semibold">Personal Information</h3>
      <Card>
        <CardContent className="pt-6">
          <Form {...nameForm}>
            <form onSubmit={nameForm.handleSubmit(onSubmitName)} className="flex flex-col gap-4">
              <FormField
                control={nameForm.control}
                name="preferredName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Preferred Name</FormLabel>
                    <FormControl>
                      <Input placeholder="Your name" {...field} />
                    </FormControl>
                    <FormDescription>Your assistant will use this name to address you.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex justify-end">
                <Button type="submit" disabled={saveNameMutation.isPending}>
                  {saveNameMutation.isPending ? 'Saving...' : 'Save'}
                </Button>
                {showNameSaved && <span className="ml-3 text-sm text-green-500 flex items-center">Settings saved!</span>}
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>

      <h3 className="text-lg font-semibold">Location</h3>
      <Card>
        <CardContent className="pt-6">
          <Form {...locationForm}>
            <form onSubmit={locationForm.handleSubmit(onSubmitLocation)} className="flex flex-col gap-4">
              <FormField
                control={locationForm.control}
                name="locationName"
                render={({ field }) => (
                  <FormItem className="flex flex-col">
                    <FormLabel>Location</FormLabel>
                    <Popover open={open} onOpenChange={setOpen}>
                      <PopoverTrigger asChild>
                        <FormControl>
                          <Button variant="outline" role="combobox" aria-expanded={open} className={cn('w-full justify-between', !field.value && 'text-muted-foreground')}>
                            {field.value || 'Select location...'}
                            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                          </Button>
                        </FormControl>
                      </PopoverTrigger>
                      <PopoverContent className="p-0 w-full" align="start">
                        <Command>
                          <CommandInput placeholder="Search for locations..." value={searchQuery} onValueChange={setSearchQuery} />
                          {isSearching && <div className="py-6 text-center text-sm">Searching...</div>}
                          {!isSearching && (
                            <>
                              <CommandEmpty>No locations found.</CommandEmpty>
                              <CommandGroup>
                                {locations.map((location) => (
                                  <CommandItem key={`${location.coordinates.lat}-${location.coordinates.lng}`} value={location.name} onSelect={() => handleSelectLocation(location)}>
                                    <Check className={cn('mr-2 h-4 w-4', location.name === field.value ? 'opacity-100' : 'opacity-0')} />
                                    {location.name}
                                  </CommandItem>
                                ))}
                              </CommandGroup>
                            </>
                          )}
                        </Command>
                      </PopoverContent>
                    </Popover>
                    <FormDescription>Select your location to enable location-based features.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex justify-end">
                <Button type="submit" disabled={saveLocationMutation.isPending}>
                  {saveLocationMutation.isPending ? 'Saving...' : 'Save'}
                </Button>
                {showLocationSaved && <span className="ml-3 text-sm text-green-500 flex items-center">Settings saved!</span>}
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>

      <h3 className="text-lg font-semibold">Cloud Provider</h3>
      <Card>
        <CardContent className="pt-6">
          <Form {...cloudForm}>
            <form onSubmit={cloudForm.handleSubmit(onSubmitCloud)} className="flex flex-col gap-4">
              <FormField
                control={cloudForm.control}
                name="cloudUrl"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Cloud URL</FormLabel>
                    <FormControl>
                      <Input placeholder="https://your-cloud-provider.com" {...field} />
                    </FormControl>
                    <FormDescription>Enter your cloud provider URL for syncing.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex justify-end">
                <Button type="submit" disabled={saveCloudMutation.isPending}>
                  {saveCloudMutation.isPending ? 'Saving...' : 'Save'}
                </Button>
                {showCloudSaved && <span className="ml-3 text-sm text-green-500 flex items-center">Settings saved!</span>}
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  )
}
