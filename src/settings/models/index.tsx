import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useDatabase } from '@/hooks/use-database'
import { modelsTable } from '@/db/tables'
import { createModel } from '@/lib/ai'
import { cn } from '@/lib/utils'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { generateText } from 'ai'
import { eq } from 'drizzle-orm'
import ky from 'ky'
import { Check, ChevronsUpDown, Loader2, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'

interface Model {
  id: string
  provider: 'openai' | 'fireworks' | 'openai_compatible' | 'thunderbolt' | 'flower' | 'together'
  name: string
  model: string
  url: string | null
  apiKey: string | null
  isSystem: number | null
  enabled: number
  toolUsage: number | null
}

interface AvailableModel {
  id: string
  name?: string
  created?: number
  owned_by?: string
}

const formSchema = z
  .object({
    provider: z.enum(['thunderbolt', 'openai', 'fireworks', 'openai_compatible', 'flower', 'together']),
    name: z.string().min(1, { message: 'Name is required.' }),
    model: z.string().min(1, { message: 'Model name is required.' }),
    customModel: z.string().optional(),
    url: z.string().optional(),
    apiKey: z.string().optional(),
    toolUsage: z.boolean(),
  })
  .refine(
    (data) => {
      if (data.provider === 'openai_compatible') {
        return data.url !== undefined && data.url.length > 0
      }
      return true
    },
    {
      message: 'URL is required for OpenAI Compatible providers',
      path: ['url'],
    }
  )
  .refine(
    (data) => {
      if (data.provider === 'thunderbolt' || data.provider === 'flower') {
        return true // API key not required for thunderbolt or flower
      }
      if (data.provider === 'openai_compatible') {
        return true // API key is optional for openai_compatible
      }
      return data.apiKey !== undefined && data.apiKey.length > 0
    },
    {
      message: 'API Key is required for this provider',
      path: ['apiKey'],
    }
  )

export default function ModelsPage() {
  const { db } = useDatabase()
  const queryClient = useQueryClient()
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState<string | null>(null)
  const [isTestingConnection, setIsTestingConnection] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [modelSelectOpen, setModelSelectOpen] = useState(false)
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([])
  const [isLoadingModels, setIsLoadingModels] = useState(false)
  const [selectedModelId, setSelectedModelId] = useState<string>('')
  const [allAvailableModels, setAllAvailableModels] = useState<AvailableModel[]>([])
  const [modelSearchQuery, setModelSearchQuery] = useState('')

  const { data: models = [] } = useQuery({
    queryKey: ['models'],
    queryFn: async (): Promise<Model[]> => {
      return await db.select().from(modelsTable)
    },
  })

  const toggleModelMutation = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      await db
        .update(modelsTable)
        .set({ enabled: enabled ? 1 : 0 })
        .where(eq(modelsTable.id, id))
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['models'] })
    },
  })

  const addModelMutation = useMutation({
    mutationFn: async (values: z.infer<typeof formSchema>) => {
      await db.insert(modelsTable).values({
        id: uuidv7(),
        ...values,
        apiKey: values.apiKey || null,
        url: values.url || null,
        isSystem: 0,
        enabled: 1,
        toolUsage: values.toolUsage ? 1 : 0,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['models'] })
      setIsAddDialogOpen(false)
      setConnectionStatus('idle')
      setConnectionError(null)
      form.reset()
    },
  })

  const deleteModelMutation = useMutation({
    mutationFn: async (id: string) => {
      await db.delete(modelsTable).where(eq(modelsTable.id, id))
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['models'] })
      setDeleteConfirmOpen(null)
    },
  })

  type FormData = z.infer<typeof formSchema>

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      provider: 'thunderbolt',
      name: '',
      model: '',
      customModel: '',
      url: '',
      apiKey: '',
      toolUsage: true,
    },
  })

  // Load Thunderbolt models when dialog opens
  useEffect(() => {
    if (isAddDialogOpen && form.getValues('provider') === 'thunderbolt' && availableModels.length === 0) {
      fetchAvailableModels('thunderbolt')
    }
  }, [isAddDialogOpen])

  const onSubmit = (values: z.infer<typeof formSchema>) => {
    // Use customModel if it's a custom selection, otherwise use model
    const modelId = selectedModelId === 'custom' && values.customModel ? values.customModel : values.model

    addModelMutation.mutate({
      ...values,
      model: modelId,
    })
  }

  const testConnection = async () => {
    const values = form.getValues()
    const modelId = selectedModelId === 'custom' && values.customModel ? values.customModel : values.model

    if (!values.provider || !modelId) {
      return
    }

    setIsTestingConnection(true)
    setConnectionStatus('idle')
    setConnectionError(null)

    // Create a timeout promise
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error('Connection test timed out after 10 seconds'))
      }, 10000)
    })

    try {
      console.log('Testing model connection:', values)

      // Create a temporary model configuration
      const modelConfig = {
        id: 'test',
        name: values.name || 'Test Model',
        provider: values.provider,
        model: modelId,
        url: values.url || null,
        apiKey: values.apiKey || null,
        isSystem: 0,
        enabled: 1,
      }

      // Use the same createModel function as the chat
      const modelConfigWithDefaults = { ...modelConfig, toolUsage: 1, isConfidential: 0 }
      const model = await createModel(modelConfigWithDefaults)

      // Test with a minimal prompt - race against timeout
      const { text } = await Promise.race([
        generateText({
          model,
          prompt: 'Say "test successful" if you can read this.',
          maxRetries: 0,
        }),
        timeoutPromise,
      ])

      console.log('Model test response:', text)
      setConnectionStatus('success')
    } catch (error) {
      console.error('Connection test error:', error)
      setConnectionStatus('error')
      setConnectionError(error instanceof Error ? error.message : 'Failed to connect to model')
    } finally {
      setIsTestingConnection(false)
    }
  }

  const handleDialogOpenChange = (open: boolean) => {
    setIsAddDialogOpen(open)
    if (!open) {
      // Reset ALL state when dialog closes
      setConnectionStatus('idle')
      setConnectionError(null)
      setAvailableModels([])
      setAllAvailableModels([])
      setSelectedModelId('')
      setModelSearchQuery('')
      setIsLoadingModels(false)
      setIsTestingConnection(false)
      form.reset()
      form.clearErrors()
    } else {
      // When opening, if provider is thunderbolt, load the models
      if (form.getValues('provider') === 'thunderbolt') {
        fetchAvailableModels('thunderbolt')
      }
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Only handle Enter key on input elements
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
      e.preventDefault()

      const values = form.getValues()
      const modelId = selectedModelId === 'custom' && values.customModel ? values.customModel : values.model

      // Check if we can test connection
      if (connectionStatus !== 'success' && values.provider && modelId) {
        testConnection()
      }
      // If connection is successful, submit the form
      else if (connectionStatus === 'success') {
        form.handleSubmit(onSubmit)()
      }
    }
    // Let all other keys and elements handle their default behavior
  }

  const fetchAvailableModels = async (provider: string, apiKey?: string, url?: string) => {
    setIsLoadingModels(true)
    setAvailableModels([])
    setAllAvailableModels([])

    try {
      let endpoint = ''
      let headers: Record<string, string> = {}

      switch (provider) {
        case 'openai':
          endpoint = 'https://api.openai.com/v1/models'
          headers = { Authorization: `Bearer ${apiKey}` }
          break
        case 'fireworks':
          endpoint = 'https://api.fireworks.ai/inference/v1/models'
          headers = { Authorization: `Bearer ${apiKey}` }
          break
        case 'together':
          endpoint = 'https://api.together.xyz/v1/models'
          headers = { Authorization: `Bearer ${apiKey}` }
          break
        case 'openai_compatible':
          if (url) {
            // Ensure URL ends with /v1 if not already
            const baseUrl = url.endsWith('/v1') ? url : url.endsWith('/') ? `${url}v1` : `${url}/v1`
            endpoint = `${baseUrl}/models`
            if (apiKey) {
              headers = { Authorization: `Bearer ${apiKey}` }
            }
          }
          break
        case 'thunderbolt':
          const thunderboltModels = [
            { id: 'llama-v3p1-70b-instruct', name: 'Llama 3.1 70B' },
            { id: 'llama-v3p1-405b-instruct', name: 'Llama 3.1 405B' },
            { id: 'qwen3-235b-a22b', name: 'Qwen 3 235B' },
            { id: 'qwen2p5-72b-instruct', name: 'Qwen 2.5 72B' },
            // { id: 'deepseek-r1-0528', name: 'DeepSeek R1 671B' },
          ]
          setAllAvailableModels(thunderboltModels)
          setAvailableModels(thunderboltModels)
          setIsLoadingModels(false)
          return
      }

      if (endpoint) {
        // For OpenAI Compatible, try even without API key, otherwise require API key
        if (provider === 'openai_compatible' || apiKey) {
          const response = await ky.get(endpoint, { headers }).json<{ data: AvailableModel[] }>()

          let models = response.data || []

          // Sort models alphabetically by ID
          models = models.sort((a, b) => a.id.localeCompare(b.id))

          // Store all models for search functionality
          setAllAvailableModels(models)

          // Show top 10 models by default
          const top10Models = models.slice(0, 10)
          setAvailableModels(top10Models)
        }
      }
    } catch (error) {
      console.error('Failed to fetch models:', error)
      setAvailableModels([])
      setAllAvailableModels([])
    } finally {
      setIsLoadingModels(false)
    }
  }

  const generateModelName = async (modelId: string) => {
    try {
      // Use a system model to generate the name
      const model = await createModel({
        id: 'system',
        name: 'System',
        provider: 'thunderbolt',
        model: 'llama-v3p1-70b-instruct',
        url: null,
        apiKey: null,
        isSystem: 1,
        enabled: 1,
        toolUsage: 1,
        isConfidential: 0,
      })

      const { text } = await generateText({
        model,
        prompt: `Generate a short, friendly display name (max 20 characters) for this AI model ID: "${modelId}". Return only the name, no quotes or punctuation. Examples: "GPT-4 Turbo", "Claude 3 Opus", "Llama 2 70B"`,
        maxRetries: 0,
      })

      return text.trim()
    } catch (error) {
      console.error('Failed to generate model name:', error)
      // Fallback: clean up the model ID
      return modelId.split('/').pop()?.replace(/-/g, ' ').replace(/_/g, ' ') || modelId
    }
  }

  const handleSelectModel = async (modelId: string) => {
    setSelectedModelId(modelId)

    if (modelId === 'custom') {
      form.setValue('model', '')
      form.setValue('customModel', '')
      form.setValue('name', '')
    } else {
      form.setValue('model', modelId)
      form.setValue('customModel', '')

      // Find the model in all available models (not just the filtered ones)
      const model = allAvailableModels.find((m) => m.id === modelId) || availableModels.find((m) => m.id === modelId)

      if (model?.name) {
        form.setValue('name', model.name)
      } else {
        // Generate a name
        const generatedName = await generateModelName(modelId)
        form.setValue('name', generatedName)
      }
    }

    setModelSelectOpen(false)
    setModelSearchQuery('') // Clear search when model is selected
  }

  // Watch for provider changes with proper cleanup
  const watchedProvider = form.watch('provider')
  const previousProviderRef = useRef(watchedProvider)

  useEffect(() => {
    const currentProvider = watchedProvider
    const previousProvider = previousProviderRef.current

    // Only act when provider actually changes (not on initial render)
    if (currentProvider !== previousProvider) {
      // Reset model selection when provider changes
      setSelectedModelId('')
      setAvailableModels([])
      setAllAvailableModels([])
      setModelSearchQuery('')

      // Reset form fields (excluding provider) using setValue with proper options
      form.setValue('name', '', { shouldValidate: false, shouldDirty: false })
      form.setValue('model', '', { shouldValidate: false, shouldDirty: false })
      form.setValue('customModel', '', { shouldValidate: false, shouldDirty: false })
      form.setValue('url', currentProvider === 'openai_compatible' ? 'http://localhost:11434/v1' : '', { shouldValidate: false, shouldDirty: false })
      form.setValue('apiKey', '', { shouldValidate: false, shouldDirty: false })
      form.setValue('toolUsage', true, { shouldValidate: false, shouldDirty: false })

      // Fetch models if we have the necessary credentials
      if (currentProvider === 'thunderbolt') {
        fetchAvailableModels(currentProvider)
      }

      // Update the ref for next comparison
      previousProviderRef.current = currentProvider
    }
  }, [watchedProvider, form])

  // Watch for API key and URL changes to refetch models
  const watchedApiKey = form.watch('apiKey')
  const watchedUrl = form.watch('url')

  useEffect(() => {
    const provider = form.getValues('provider')
    const apiKey = watchedApiKey
    const url = watchedUrl

    if (provider && (provider === 'thunderbolt' || (provider && apiKey) || (provider === 'openai_compatible' && url))) {
      fetchAvailableModels(provider, apiKey, url)
    }
  }, [watchedApiKey, watchedUrl, form])

  const getProviderDisplay = (provider: string) => {
    switch (provider) {
      case 'thunderbolt':
        return 'Thunderbolt'
      case 'openai':
        return 'OpenAI'
      case 'fireworks':
        return 'Fireworks'
      case 'openai_compatible':
        return 'OpenAI Compatible'
      case 'flower':
        return 'Flower'
      case 'together':
        return 'Together AI'
      default:
        return provider
    }
  }

  const getProviderInitial = (provider: string) => {
    return provider[0].toUpperCase()
  }

  const handleDeleteModel = (modelId: string) => {
    deleteModelMutation.mutate(modelId)
  }

  // Filter models based on search query
  const getFilteredModels = () => {
    if (!modelSearchQuery.trim()) {
      return availableModels // Show top 10 by default
    }

    // Search through all available models when user types
    return allAvailableModels.filter((model) => model.id.toLowerCase().includes(modelSearchQuery.toLowerCase()) || (model.name && model.name.toLowerCase().includes(modelSearchQuery.toLowerCase())))
  }

  return (
    <div className="flex flex-col gap-4 p-4 w-full max-w-[760px] mx-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-4xl font-bold tracking-tight mb-2 text-primary">Models</h1>
        <Dialog open={isAddDialogOpen} onOpenChange={handleDialogOpenChange}>
          <DialogTrigger asChild>
            <Button variant="outline" size="icon">
              <Plus />
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[500px]">
            <DialogHeader>
              <DialogTitle>Add Model</DialogTitle>
              <DialogDescription>Configure a new AI model for your assistant.</DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} onKeyDown={handleKeyDown} className="grid gap-4 py-4">
                <FormField
                  control={form.control}
                  name="provider"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Provider</FormLabel>
                      <FormControl>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="Select provider" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="thunderbolt">Thunderbolt</SelectItem>
                            <SelectItem value="openai">OpenAI</SelectItem>
                            <SelectItem value="fireworks">Fireworks</SelectItem>
                            <SelectItem value="openai_compatible">OpenAI Compatible</SelectItem>
                            <SelectItem value="flower">Flower</SelectItem>
                            <SelectItem value="together">Together AI</SelectItem>
                          </SelectContent>
                        </Select>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* URL for OpenAI Compatible */}
                {form.watch('provider') === 'openai_compatible' && (
                  <FormField
                    control={form.control}
                    name="url"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>URL</FormLabel>
                        <FormControl>
                          <Input {...field} placeholder="https://api.example.com/v1" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}

                {/* API Key */}
                {form.watch('provider') !== 'thunderbolt' && (
                  <FormField
                    control={form.control}
                    name="apiKey"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>API Key{form.watch('provider') === 'openai_compatible' ? ' (Optional)' : ''}</FormLabel>
                        <FormControl>
                          <Input type="password" {...field} placeholder="sk-..." />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}

                {/* Model Selection with Autocomplete - Show based on provider and API key */}
                {(() => {
                  const provider = form.watch('provider')
                  const apiKey = form.watch('apiKey')
                  const url = form.watch('url')

                  // Show model selection if:
                  // 1. Thunderbolt (no API key needed)
                  // 2. Other providers with API key
                  // 3. OpenAI Compatible with URL (API key optional)
                  const showModelSelection = provider === 'thunderbolt' || (provider && apiKey) || (provider === 'openai_compatible' && url)

                  if (!showModelSelection) return null

                  return (
                    <FormField
                      control={form.control}
                      name="model"
                      render={() => (
                        <FormItem className="flex flex-col">
                          <FormLabel>Model</FormLabel>
                          <Popover
                            open={modelSelectOpen}
                            onOpenChange={(open) => {
                              setModelSelectOpen(open)
                              if (!open) {
                                setModelSearchQuery('') // Clear search when popover closes
                              }
                            }}
                          >
                            <PopoverTrigger asChild>
                              <FormControl>
                                <Button variant="outline" role="combobox" aria-expanded={modelSelectOpen} className={cn('w-full justify-between', !selectedModelId && 'text-muted-foreground')}>
                                  {selectedModelId === 'custom' ? 'Custom Model' : selectedModelId ? availableModels.find((m) => m.id === selectedModelId)?.name || selectedModelId : 'Select model...'}
                                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                                </Button>
                              </FormControl>
                            </PopoverTrigger>
                            <PopoverContent className="p-0 w-full" side="bottom" align="start" sideOffset={4}>
                              <Command>
                                <CommandInput placeholder="Search models..." value={modelSearchQuery} onValueChange={setModelSearchQuery} />
                                <CommandList>
                                  {isLoadingModels && <div className="py-6 text-center text-sm">Loading models...</div>}
                                  {!isLoadingModels &&
                                    (() => {
                                      const filteredModels = getFilteredModels()

                                      if (filteredModels.length === 0) {
                                        return <CommandEmpty>{modelSearchQuery ? 'No models found matching your search.' : 'No models found.'}</CommandEmpty>
                                      }

                                      return (
                                        <CommandGroup>
                                          {!modelSearchQuery && availableModels.length === 10 && allAvailableModels.length > 10 && (
                                            <div className="px-2 py-1 text-xs text-muted-foreground">Showing top 10 models. Type to search all {allAvailableModels.length} models.</div>
                                          )}
                                          {filteredModels.map((model) => (
                                            <CommandItem key={model.id} value={model.id} onSelect={() => handleSelectModel(model.id)}>
                                              <Check className={cn('mr-2 h-4 w-4', selectedModelId === model.id ? 'opacity-100' : 'opacity-0')} />
                                              <div className="flex flex-col">
                                                <span>{model.name || model.id}</span>
                                                {model.name && <span className="text-xs text-muted-foreground">{model.id}</span>}
                                              </div>
                                            </CommandItem>
                                          ))}
                                          {form.watch('provider') !== 'thunderbolt' && (
                                            <CommandItem value="custom" onSelect={() => handleSelectModel('custom')}>
                                              <Check className={cn('mr-2 h-4 w-4', selectedModelId === 'custom' ? 'opacity-100' : 'opacity-0')} />
                                              <span className="italic">Custom</span>
                                            </CommandItem>
                                          )}
                                        </CommandGroup>
                                      )
                                    })()}
                                </CommandList>
                              </Command>
                            </PopoverContent>
                          </Popover>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  )
                })()}

                {/* Custom Model Input */}
                {selectedModelId === 'custom' && (
                  <FormField
                    control={form.control}
                    name="customModel"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Model</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            placeholder="e.g., gpt-4-turbo-preview"
                            onChange={(e) => {
                              field.onChange(e)
                              form.setValue('model', e.target.value)
                            }}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}

                {/* Display Name - Only show when model is selected */}
                {(form.watch('model') || selectedModelId === 'custom') && (
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Display Name</FormLabel>
                        <FormControl>
                          <Input {...field} placeholder="e.g., GPT-4 Turbo" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}

                {/* Tool Usage Checkbox - Only show when model is selected */}
                {(form.watch('model') || selectedModelId === 'custom') && (
                  <FormField
                    control={form.control}
                    name="toolUsage"
                    render={({ field }) => (
                      <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4">
                        <FormControl>
                          <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                        </FormControl>
                        <div className="space-y-1 leading-none">
                          <FormLabel>Enable tool usage</FormLabel>
                          <p className="text-sm text-muted-foreground">Allow this model to use tools and function calls. Disable if the model doesn't support tools.</p>
                        </div>
                      </FormItem>
                    )}
                  />
                )}

                {/* Test Connection Button */}
                {form.watch('model') && (
                  <Button type="button" onClick={testConnection} disabled={isTestingConnection} variant="outline" className="w-full">
                    {isTestingConnection ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Testing Connection...
                      </>
                    ) : (
                      'Test Connection'
                    )}
                  </Button>
                )}

                {/* Connection Status Messages */}
                {connectionStatus === 'success' && (
                  <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
                    <div className="flex items-center gap-2 text-green-800">
                      <Check className="h-4 w-4" />
                      <span className="font-medium">Connection successful!</span>
                    </div>
                    <p className="text-sm text-green-600 mt-1">The model is working correctly and ready to use.</p>
                  </div>
                )}

                {connectionStatus === 'error' && (
                  <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
                    <div className="flex items-center gap-2 text-red-800">
                      <X className="h-4 w-4" />
                      <span className="font-medium">Connection failed</span>
                    </div>
                    <p className="text-sm text-red-600 mt-1">{connectionError || 'Could not connect to the model. Please check your configuration.'}</p>
                  </div>
                )}

                <div className="flex justify-end gap-3">
                  <Button variant="outline" onClick={() => handleDialogOpenChange(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={addModelMutation.isPending || connectionStatus !== 'success'}>
                    {addModelMutation.isPending ? 'Adding...' : 'Add Model'}
                  </Button>
                </div>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid gap-4">
        {models.map((model) => {
          const isEnabled = model.enabled === 1
          const isSystemModel = model.isSystem === 1

          return (
            <Card key={model.id} className="border border-border shadow-sm">
              <CardHeader className="py-0">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className="flex items-center justify-center bg-primary text-primary-foreground size-8 rounded-md font-medium flex-shrink-0">{getProviderInitial(model.provider)}</div>
                    <div className="min-w-0 flex-1">
                      <CardTitle className="text-lg font-medium">{model.name}</CardTitle>
                      <p className="text-sm text-muted-foreground">
                        {getProviderDisplay(model.provider)} - {model.model}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div>
                            <Switch checked={isEnabled} onCheckedChange={(checked) => toggleModelMutation.mutate({ id: model.id, enabled: checked })} className="cursor-pointer" />
                          </div>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">
                          <p>{isEnabled ? 'Disable model' : 'Enable model'}</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                    {isSystemModel ? (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button variant="ghost" size="sm" className="h-8 w-8 p-0" disabled>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">
                            <p>System models can't be deleted</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    ) : (
                      <Popover open={deleteConfirmOpen === model.id} onOpenChange={(open) => setDeleteConfirmOpen(open ? model.id : null)}>
                        <PopoverTrigger asChild>
                          <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-80" side="bottom" align="end">
                          <div className="space-y-3">
                            <div>
                              <h4 className="font-medium">Remove Model</h4>
                              <p className="text-sm text-muted-foreground">Are you sure you want to remove this model? This action cannot be undone.</p>
                            </div>
                            <div className="flex justify-end gap-2">
                              <Button variant="outline" size="sm" onClick={() => setDeleteConfirmOpen(null)}>
                                Cancel
                              </Button>
                              <Button variant="destructive" size="sm" onClick={() => handleDeleteModel(model.id)}>
                                Remove
                              </Button>
                            </div>
                          </div>
                        </PopoverContent>
                      </Popover>
                    )}
                  </div>
                </div>
              </CardHeader>
              {isEnabled && (
                <CardContent className="pt-0 border-t">
                  <div className="space-y-3 pt-4">
                    {model.provider !== 'thunderbolt' && model.apiKey && (
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-muted-foreground">API Key</span>
                        <span className="text-sm font-mono">{'•'.repeat(8)}</span>
                      </div>
                    )}
                    {model.url && (
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-muted-foreground">URL</span>
                        <span className="text-sm font-mono truncate max-w-[300px]">{model.url}</span>
                      </div>
                    )}
                    {model.provider === 'thunderbolt' && <div className="text-sm text-muted-foreground">Uses Thunderbolt cloud service</div>}
                  </div>
                </CardContent>
              )}
            </Card>
          )
        })}

        {models.length === 0 && (
          <Card className="border-dashed border-2 border-muted-foreground/25">
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-4">
                <Plus className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="font-medium text-foreground mb-1">No models configured</h3>
              <p className="text-sm text-muted-foreground mb-4">Get started by adding your first AI model.</p>
              <Button onClick={() => setIsAddDialogOpen(true)} variant="outline">
                <Plus className="h-4 w-4 mr-2" />
                Add Model
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
