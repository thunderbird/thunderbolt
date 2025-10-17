import { useState, useEffect, useReducer } from 'react'
import { Button } from '@/components/ui/button'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { settingsTable } from '@/db/tables'
import { DatabaseSingleton } from '@/db/singleton'
import { useDebounce } from '@/hooks/use-debounce'
import { cn } from '@/lib/utils'
import { ChevronsUpDown } from 'lucide-react'
import { eq } from 'drizzle-orm'
import ky from 'ky'

interface LocationData {
  name: string
  city: string
  coordinates: {
    lat: number
    lng: number
  }
}

type LocationState = {
  open: boolean
  searchQuery: string
  locations: LocationData[]
  isSearching: boolean
}

type LocationAction =
  | { type: 'SET_OPEN'; payload: boolean }
  | { type: 'SET_SEARCH_QUERY'; payload: string }
  | { type: 'SET_LOCATIONS'; payload: LocationData[] }
  | { type: 'SET_IS_SEARCHING'; payload: boolean }
  | { type: 'CLEAR_LOCATION_SEARCH' }

const initialLocationState: LocationState = {
  open: false,
  searchQuery: '',
  locations: [],
  isSearching: false,
}

const locationReducer = (state: LocationState, action: LocationAction): LocationState => {
  switch (action.type) {
    case 'SET_OPEN':
      return { ...state, open: action.payload }
    case 'SET_SEARCH_QUERY':
      return { ...state, searchQuery: action.payload }
    case 'SET_LOCATIONS':
      return { ...state, locations: action.payload }
    case 'SET_IS_SEARCHING':
      return { ...state, isSearching: action.payload }
    case 'CLEAR_LOCATION_SEARCH':
      return { ...state, searchQuery: '', locations: [] }
    default:
      return state
  }
}

const step1FormSchema = z.object({
  preferredName: z.string().min(1, { message: 'Name is required.' }),
  locationName: z.string().min(1, { message: 'Location is required.' }),
  locationLat: z.number().optional(),
  locationLng: z.number().optional(),
})

type Step1FormData = z.infer<typeof step1FormSchema>

type OnboardingStep1Props = {
  onCompleteStep1: () => void
}

export default function OnboardingStep1({ onCompleteStep1 }: OnboardingStep1Props) {
  const db = DatabaseSingleton.instance.db
  const queryClient = useQueryClient()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [locationState, dispatch] = useReducer(locationReducer, initialLocationState)
  const { open, searchQuery, locations, isSearching } = locationState

  const form = useForm<Step1FormData>({
    resolver: zodResolver(step1FormSchema),
    defaultValues: {
      preferredName: '',
      locationName: '',
      locationLat: undefined,
      locationLng: undefined,
    },
  })

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
        // Get cloud_url from database settings
        const cloudUrlData = await db.select().from(settingsTable).where(eq(settingsTable.key, 'cloud_url'))
        const cloudUrl = cloudUrlData[0]?.value

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
  }, [debouncedSearchQuery, db])

  const saveUserInfoMutation = useMutation({
    mutationFn: async (values: Step1FormData) => {
      // Save preferred name
      await db
        .insert(settingsTable)
        .values({ key: 'preferred_name', value: values.preferredName })
        .onConflictDoUpdate({
          target: settingsTable.key,
          set: { value: values.preferredName },
        })

      // Save location name
      await db
        .insert(settingsTable)
        .values({ key: 'location_name', value: values.locationName })
        .onConflictDoUpdate({
          target: settingsTable.key,
          set: { value: values.locationName },
        })

      // Save coordinates if available
      if (values.locationLat !== undefined) {
        await db
          .insert(settingsTable)
          .values({ key: 'location_lat', value: values.locationLat.toString() })
          .onConflictDoUpdate({
            target: settingsTable.key,
            set: { value: values.locationLat.toString() },
          })
      }

      if (values.locationLng !== undefined) {
        await db
          .insert(settingsTable)
          .values({ key: 'location_lng', value: values.locationLng.toString() })
          .onConflictDoUpdate({
            target: settingsTable.key,
            set: { value: values.locationLng.toString() },
          })
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] })
      onCompleteStep1()
    },
  })

  const handleSelectLocation = (location: LocationData) => {
    form.setValue('locationName', location.name)
    form.setValue('locationLat', location.coordinates.lat)
    form.setValue('locationLng', location.coordinates.lng)
    dispatch({ type: 'SET_OPEN', payload: false })
  }

  const onSubmit = async (values: Step1FormData) => {
    setIsSubmitting(true)
    try {
      await saveUserInfoMutation.mutateAsync(values)
    } finally {
      setIsSubmitting(false)
    }
  }
  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        <div className="text-center space-y-4">
          <h2 className="text-2xl font-bold">Welcome to Thunderbolt!</h2>
          <p className="text-muted-foreground">Let's personalize your experience by telling us a bit about yourself.</p>
        </div>

        <div className="space-y-4">
          <FormField
            control={form.control}
            name="preferredName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>What should we call you?</FormLabel>
                <FormControl>
                  <Input placeholder="Enter your name" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="locationName"
            render={({ field }) => (
              <FormItem className="flex flex-col">
                <FormLabel>Where are you located?</FormLabel>
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
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="pt-4">
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? 'Saving...' : 'Continue'}
          </Button>
        </div>
      </form>
    </Form>
  )
}
