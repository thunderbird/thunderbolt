import { createModel } from '@/ai/fetch'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
  ResponsiveModalTrigger,
} from '@/components/ui/responsive-modal'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { StatusCard } from '@/components/ui/status-card'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { modelsTable } from '@/db/tables'
import { useDatabase } from '@/hooks/use-database'
import { fetch } from '@/lib/fetch'
import { cn } from '@/lib/utils'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { generateText } from 'ai'
import { eq } from 'drizzle-orm'
import ky from 'ky'
import { Check, ChevronsUpDown, Loader2, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useReducer, useRef } from 'react'
import { useForm } from 'react-hook-form'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'

interface Model {
  id: string
  provider: 'openai' | 'custom' | 'openrouter' | 'thunderbolt' | 'flower'
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
  supports_tools?: boolean
  supported_parameters?: string[]
}

type ModelState = {
  isAddDialogOpen: boolean
  deleteConfirmOpen: string | null
  isTestingConnection: boolean
  connectionStatus: 'idle' | 'success' | 'error'
  connectionError: string | null
  modelSelectOpen: boolean
  availableModels: AvailableModel[]
  isLoadingModels: boolean
  selectedModelId: string
  allAvailableModels: AvailableModel[]
  modelSearchQuery: string
  modelLoadError: string | null
}

type ModelAction =
  | { type: 'OPEN_DIALOG' }
  | { type: 'CLOSE_DIALOG' }
  | { type: 'START_CONNECTION_TEST' }
  | { type: 'CONNECTION_TEST_SUCCESS' }
  | { type: 'CONNECTION_TEST_FAILURE'; error: string }
  | { type: 'FETCH_MODELS_START' }
  | { type: 'FETCH_MODELS_SUCCESS'; models: AvailableModel[] }
  | { type: 'FETCH_MODELS_FAILURE'; error: string }
  | { type: 'OPEN_MODEL_SELECT' }
  | { type: 'CLOSE_MODEL_SELECT' }
  | { type: 'UPDATE_MODEL_SEARCH_QUERY'; query: string }
  | { type: 'SELECT_MODEL'; modelId: string }
  | { type: 'PROVIDER_CHANGED' }
  | { type: 'OPEN_DELETE_CONFIRM'; modelId: string }
  | { type: 'CLOSE_DELETE_CONFIRM' }

const initialState: ModelState = {
  isAddDialogOpen: false,
  deleteConfirmOpen: null,
  isTestingConnection: false,
  connectionStatus: 'idle',
  connectionError: null,
  modelSelectOpen: false,
  availableModels: [],
  isLoadingModels: false,
  selectedModelId: '',
  allAvailableModels: [],
  modelSearchQuery: '',
  modelLoadError: null,
}

function modelReducer(state: ModelState, action: ModelAction): ModelState {
  switch (action.type) {
    case 'OPEN_DIALOG':
      // Fresh state every time the dialog is opened
      return { ...initialState, isAddDialogOpen: true }
    case 'CLOSE_DIALOG':
      return { ...initialState, isAddDialogOpen: false }

    case 'START_CONNECTION_TEST':
      return { ...state, isTestingConnection: true, connectionStatus: 'idle', connectionError: null }
    case 'CONNECTION_TEST_SUCCESS':
      return { ...state, isTestingConnection: false, connectionStatus: 'success' }
    case 'CONNECTION_TEST_FAILURE':
      return { ...state, isTestingConnection: false, connectionStatus: 'error', connectionError: action.error }

    case 'FETCH_MODELS_START':
      return {
        ...state,
        isLoadingModels: true,
        modelLoadError: null,
        availableModels: [],
        allAvailableModels: [],
      }
    case 'FETCH_MODELS_SUCCESS':
      return {
        ...state,
        isLoadingModels: false,
        availableModels: action.models,
        allAvailableModels: action.models,
      }
    case 'FETCH_MODELS_FAILURE':
      return {
        ...state,
        isLoadingModels: false,
        modelLoadError: action.error,
        availableModels: [],
        allAvailableModels: [],
      }

    case 'OPEN_MODEL_SELECT':
      return { ...state, modelSelectOpen: true }
    case 'CLOSE_MODEL_SELECT':
      return { ...state, modelSelectOpen: false, modelSearchQuery: '' }

    case 'UPDATE_MODEL_SEARCH_QUERY':
      return { ...state, modelSearchQuery: action.query }

    case 'SELECT_MODEL':
      return { ...state, selectedModelId: action.modelId, modelSelectOpen: false, modelSearchQuery: '' }

    case 'PROVIDER_CHANGED':
      return {
        ...state,
        selectedModelId: '',
        availableModels: [],
        allAvailableModels: [],
        modelSearchQuery: '',
        modelLoadError: null,
        isLoadingModels: false,
        modelSelectOpen: false,
        connectionStatus: 'idle',
        connectionError: null,
        isTestingConnection: false,
      }

    case 'OPEN_DELETE_CONFIRM':
      return { ...state, deleteConfirmOpen: action.modelId }
    case 'CLOSE_DELETE_CONFIRM':
      return { ...state, deleteConfirmOpen: null }

    default:
      return state
  }
}

const formSchema = z
  .object({
    provider: z.enum(['thunderbolt', 'openai', 'custom', 'openrouter', 'flower']),
    name: z.string().min(1, { message: 'Name is required.' }),
    model: z.string().min(1, { message: 'Model name is required.' }),
    customModel: z.string().optional(),
    url: z.string().optional(),
    apiKey: z.string().optional(),
    toolUsage: z.boolean(),
  })
  .refine(
    (data) => {
      if (data.provider === 'custom') {
        return data.url !== undefined && data.url.length > 0
      }
      return true
    },
    {
      message: 'URL is required for Custom providers',
      path: ['url'],
    },
  )
  .refine(
    (data) => {
      if (data.provider === 'thunderbolt' || data.provider === 'flower') {
        return true // API key not required for thunderbolt or flower
      }
      if (data.provider === 'custom') {
        return true // API key is optional for custom (OpenAI compatible)
      }
      return data.apiKey !== undefined && data.apiKey.length > 0
    },
    {
      message: 'API Key is required for this provider',
      path: ['apiKey'],
    },
  )

export default function ModelsPage() {
  const { db } = useDatabase()
  const queryClient = useQueryClient()
  const [state, dispatch] = useReducer(modelReducer, initialState)
  const {
    isAddDialogOpen,
    deleteConfirmOpen,
    isTestingConnection,
    connectionStatus,
    connectionError,
    modelSelectOpen,
    availableModels,
    isLoadingModels,
    selectedModelId,
    allAvailableModels,
    modelSearchQuery,
    modelLoadError,
  } = state

  // Ensure form state resets whenever the add-model dialog fully closes
  useEffect(() => {
    if (!isAddDialogOpen) {
      form.reset({
        provider: 'thunderbolt',
        name: '',
        model: '',
        customModel: '',
        url: '',
        apiKey: '',
        toolUsage: true,
      })
      form.clearErrors()
    }
  }, [isAddDialogOpen])

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
        contextWindow: null,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['models'] })
      dispatch({ type: 'CLOSE_DIALOG' })
      form.reset()
    },
  })

  const deleteModelMutation = useMutation({
    mutationFn: async (id: string) => {
      await db.delete(modelsTable).where(eq(modelsTable.id, id))
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['models'] })
      dispatch({ type: 'CLOSE_DELETE_CONFIRM' })
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

    dispatch({ type: 'START_CONNECTION_TEST' })

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
      const modelConfigWithDefaults = {
        ...modelConfig,
        toolUsage: 1,
        isConfidential: 0,
        startWithReasoning: 0,
        contextWindow: null,
        tokenizer: null,
      }
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
      dispatch({ type: 'CONNECTION_TEST_SUCCESS' })
    } catch (error) {
      console.error('Connection test error:', error)
      dispatch({
        type: 'CONNECTION_TEST_FAILURE',
        error: error instanceof Error ? error.message : 'Failed to connect to model',
      })
    }
  }

  const handleDialogOpenChange = (open: boolean) => {
    if (open) {
      // Reset form before opening to ensure clean state
      form.reset({
        provider: 'thunderbolt',
        name: '',
        model: '',
        customModel: '',
        url: '',
        apiKey: '',
        toolUsage: true,
      })
      form.clearErrors()
      dispatch({ type: 'OPEN_DIALOG' })
      if (form.getValues('provider') === 'thunderbolt') {
        fetchAvailableModels('thunderbolt')
      }
    } else {
      dispatch({ type: 'CLOSE_DIALOG' })
      // Reset form with explicit default values
      form.reset({
        provider: 'thunderbolt',
        name: '',
        model: '',
        customModel: '',
        url: '',
        apiKey: '',
        toolUsage: true,
      })
      form.clearErrors()
      // Additional cleanup to ensure form state is fully cleared
      setTimeout(() => {
        form.clearErrors()
        form.trigger() // Re-trigger validation to clear any lingering errors
      }, 0)
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
    dispatch({ type: 'FETCH_MODELS_START' })

    try {
      let endpoint = ''
      let headers: Record<string, string> = {}

      switch (provider) {
        case 'openai':
          endpoint = 'https://api.openai.com/v1/models'
          headers = { Authorization: `Bearer ${apiKey}` }
          break
        case 'custom':
          if (url) {
            // Ensure URL ends with /v1 if not already
            const baseUrl = url.endsWith('/v1') ? url : url.endsWith('/') ? `${url}v1` : `${url}/v1`
            endpoint = `${baseUrl}/models`
            if (apiKey) {
              headers = { Authorization: `Bearer ${apiKey}` }
            }
          }
          break
        case 'openrouter':
          endpoint = 'https://openrouter.ai/api/v1/models'
          headers = { Authorization: `Bearer ${apiKey}` }
          break
        case 'thunderbolt':
          const thunderboltModels = [
            { id: 'kimi-k2-instruct', name: 'Kimi K2', supports_tools: true },
            { id: 'deepseek-r1-0528', name: 'DeepSeek R1', supports_tools: true },
            { id: 'qwen3-235b-a22b-instruct-2507', name: 'Qwen 3', supports_tools: true },
            { id: 'qwen3-235b-a22b-thinking-2507', name: 'Qwen 3 (Thinking)', supports_tools: true },
            { id: 'llama-v3p1-405b-instruct', name: 'Llama 3.1', supports_tools: true },
          ]
          dispatch({ type: 'FETCH_MODELS_SUCCESS', models: thunderboltModels })
          return
      }

      if (endpoint) {
        // For Custom (OpenAI Compatible), try even without API key, otherwise require API key
        if (provider === 'custom' || apiKey) {
          const response = await ky.get(endpoint, { headers, fetch }).json<{ data: AvailableModel[] }>()

          let models = (response.data || []).map((m) => {
            const supportsToolsByParams =
              Array.isArray((m as any).supported_parameters) &&
              ((m as any).supported_parameters.includes('tools') ||
                (m as any).supported_parameters.includes('tool_choice'))

            const supports_tools = (m as any).supports_tools === true || supportsToolsByParams

            return { ...m, supports_tools }
          })

          // Sort models alphabetically by ID
          models = models.sort((a, b) => a.id.localeCompare(b.id))

          // Store all models for search functionality
          dispatch({ type: 'FETCH_MODELS_SUCCESS', models })
        }
      }
    } catch (error) {
      console.error('Failed to fetch models:', error)

      // Browser/network failure (could be offline, CORS, cert error, etc.)
      if (error instanceof TypeError) {
        dispatch({
          type: 'FETCH_MODELS_FAILURE',
          error: 'Network request failed (the browser blocked the request or the server is unreachable).',
        })
      }
      // ky HTTPError with a Response object
      else if (typeof error === 'object' && error && 'response' in error) {
        // @ts-expect-error – ky HTTPError shape
        const response: Response | undefined = error.response
        if (response) {
          dispatch({
            type: 'FETCH_MODELS_FAILURE',
            error: `Server responded with status ${response.status} ${response.statusText}`,
          })
        } else {
          dispatch({ type: 'FETCH_MODELS_FAILURE', error: 'Server responded with an unknown error.' })
        }
      }
      // Generic JavaScript error
      else if (error instanceof Error && error.message) {
        dispatch({ type: 'FETCH_MODELS_FAILURE', error: error.message })
      } else {
        dispatch({ type: 'FETCH_MODELS_FAILURE', error: 'Failed to load models' })
      }

      // No models could be fetched; state already handled in failure action
    } finally {
      // Nothing to do in finally; state set in success/failure actions
    }
  }

  // Generate a human-readable name from a model ID (no LLM call required)
  const generateModelName = (modelId: string): string => {
    const segment = modelId.split('/').pop() ?? modelId
    const beforeColon = segment.split(':')[0]
    const rawParts = beforeColon.split(/[-_]+/)
    const tokens: string[] = []

    for (const part of rawParts) {
      // Keep short patterns like "r1", "v3" together
      if (/^[A-Za-z]\d$/.test(part)) {
        tokens.push(part)
        continue
      }

      // Otherwise split letters/numbers
      const sub = part.match(/[A-Za-z]+|[0-9]+(?:\.[0-9]+)?/g) ?? []
      tokens.push(...sub)
    }

    return tokens
      .map((t) => {
        // If token is purely numeric, keep as is; otherwise title-case it
        return /^[0-9]+$/.test(t) ? t : t.charAt(0).toUpperCase() + t.slice(1)
      })
      .join(' ')
  }

  const handleSelectModel = async (modelId: string) => {
    dispatch({ type: 'SELECT_MODEL', modelId: modelId })

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
        // Generate a name locally
        const generatedName = generateModelName(modelId)
        form.setValue('name', generatedName)
      }

      // Set tool usage based on model support
      const supportsTools = (model as any)?.supports_tools === true
      form.setValue('toolUsage', supportsTools, { shouldDirty: false })
    }

    dispatch({ type: 'CLOSE_MODEL_SELECT' })
  }

  // Watch for provider changes with proper cleanup
  const watchedProvider = form.watch('provider')
  const previousProviderRef = useRef(watchedProvider)

  useEffect(() => {
    const currentProvider = watchedProvider
    const previousProvider = previousProviderRef.current

    // Only act when provider actually changes (not on initial render)
    if (currentProvider !== previousProvider) {
      dispatch({ type: 'PROVIDER_CHANGED' })

      // Reset form fields (excluding provider) using setValue with proper options
      form.setValue('name', '', { shouldValidate: false, shouldDirty: false })
      form.setValue('model', '', { shouldValidate: false, shouldDirty: false })
      form.setValue('customModel', '', { shouldValidate: false, shouldDirty: false })
      form.setValue('url', currentProvider === 'custom' ? 'http://localhost:11434/v1' : '', {
        shouldValidate: false,
        shouldDirty: false,
      })
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

    if (provider && (provider === 'thunderbolt' || (provider && apiKey) || (provider === 'custom' && url))) {
      fetchAvailableModels(provider, apiKey, url)
    }
  }, [watchedApiKey, watchedUrl, form])

  const getProviderDisplay = (provider: string) => {
    switch (provider) {
      case 'thunderbolt':
        return 'Thunderbolt'
      case 'openai':
        return 'OpenAI'
      case 'custom':
        return 'Custom'
      case 'openrouter':
        return 'OpenRouter'
      case 'flower':
        return 'Flower'
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
    return allAvailableModels.filter(
      (model) =>
        model.id.toLowerCase().includes(modelSearchQuery.toLowerCase()) ||
        (model.name && model.name.toLowerCase().includes(modelSearchQuery.toLowerCase())),
    )
  }

  // Calculate whether the currently selected model supports tools
  const supportsToolsSelected = (() => {
    if (!selectedModelId || selectedModelId === 'custom') return true
    const model =
      allAvailableModels.find((m) => m.id === selectedModelId) || availableModels.find((m) => m.id === selectedModelId)
    return (model as any)?.supports_tools === true
  })()

  return (
    <div className="flex flex-col gap-4 p-4 w-full max-w-[760px] mx-auto">
      <div className="flex items-center justify-between">
        <h1 className="mt-8 text-4xl font-bold tracking-tight mb-2 text-primary">Models</h1>
        <ResponsiveModal open={isAddDialogOpen} onOpenChange={handleDialogOpenChange}>
          <ResponsiveModalTrigger asChild>
            <Button variant="outline" size="icon">
              <Plus />
            </Button>
          </ResponsiveModalTrigger>
          <ResponsiveModalContent className="sm:max-w-[500px] max-h-[90vh] overflow-y-auto">
            <ResponsiveModalHeader>
              <ResponsiveModalTitle>Add Model</ResponsiveModalTitle>
              <ResponsiveModalDescription>Configure a new AI model for your assistant.</ResponsiveModalDescription>
            </ResponsiveModalHeader>
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
                            <SelectItem value="openrouter">OpenRouter</SelectItem>
                            <SelectItem value="flower">Flower</SelectItem>
                            <SelectItem value="custom">Custom</SelectItem>
                          </SelectContent>
                        </Select>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* URL for OpenAI Compatible */}
                {form.watch('provider') === 'custom' && (
                  <FormField
                    control={form.control}
                    name="url"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>URL</FormLabel>
                        <FormControl>
                          <div className="relative">
                            <Input {...field} placeholder="http://localhost:11434/v1" className="pr-10" />
                            {isLoadingModels && (
                              <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
                            )}
                          </div>
                        </FormControl>
                        {modelLoadError && (
                          <p className="text-sm text-destructive mt-1 whitespace-pre-line">{modelLoadError}</p>
                        )}
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
                        <FormLabel>API Key{form.watch('provider') === 'custom' ? ' (Optional)' : ''}</FormLabel>
                        <FormControl>
                          <Input type="password" {...field} placeholder="sk-..." />
                        </FormControl>
                        {modelLoadError && form.watch('provider') !== 'custom' && (
                          <p className="text-sm text-destructive mt-1 whitespace-pre-line">{modelLoadError}</p>
                        )}
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
                  const showModelSelection =
                    !modelLoadError &&
                    (provider === 'thunderbolt' || (provider && apiKey) || (provider === 'custom' && url))

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
                              if (open) {
                                dispatch({ type: 'OPEN_MODEL_SELECT' })
                              } else {
                                dispatch({ type: 'CLOSE_MODEL_SELECT' })
                              }
                            }}
                          >
                            <PopoverTrigger asChild>
                              <FormControl>
                                <Button
                                  variant="outline"
                                  role="combobox"
                                  aria-expanded={modelSelectOpen}
                                  className={cn('w-full justify-between', !selectedModelId && 'text-muted-foreground')}
                                >
                                  {selectedModelId === 'custom'
                                    ? 'Custom Model'
                                    : selectedModelId
                                      ? availableModels.find((m) => m.id === selectedModelId)?.name || selectedModelId
                                      : 'Select model...'}
                                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                                </Button>
                              </FormControl>
                            </PopoverTrigger>
                            <PopoverContent className="p-0 w-full" side="bottom" align="start" sideOffset={4}>
                              <Command>
                                <CommandInput
                                  placeholder="Search models..."
                                  value={modelSearchQuery}
                                  onValueChange={(value) =>
                                    dispatch({ type: 'UPDATE_MODEL_SEARCH_QUERY', query: value })
                                  }
                                />
                                <div className="h-[200px] overflow-y-auto">
                                  <CommandList className="max-h-none">
                                    {isLoadingModels && (
                                      <div className="py-6 text-center text-sm">Loading models...</div>
                                    )}
                                    {!isLoadingModels &&
                                      (() => {
                                        const filteredModels = getFilteredModels()

                                        if (filteredModels.length === 0) {
                                          return (
                                            <CommandEmpty>
                                              {modelSearchQuery
                                                ? 'No models found matching your search.'
                                                : 'No models found.'}
                                            </CommandEmpty>
                                          )
                                        }

                                        return (
                                          <CommandGroup>
                                            {filteredModels.map((model) => (
                                              <CommandItem
                                                key={model.id}
                                                value={model.id}
                                                onSelect={() => handleSelectModel(model.id)}
                                              >
                                                <Check
                                                  className={cn(
                                                    'mr-2 h-4 w-4',
                                                    selectedModelId === model.id ? 'opacity-100' : 'opacity-0',
                                                  )}
                                                />
                                                <div className="flex flex-col">
                                                  <span>{model.name || model.id}</span>
                                                  {model.name && (
                                                    <span className="text-xs text-muted-foreground">{model.id}</span>
                                                  )}
                                                </div>
                                              </CommandItem>
                                            ))}
                                            {form.watch('provider') !== 'thunderbolt' && (
                                              <CommandItem value="custom" onSelect={() => handleSelectModel('custom')}>
                                                <Check
                                                  className={cn(
                                                    'mr-2 h-4 w-4',
                                                    selectedModelId === 'custom' ? 'opacity-100' : 'opacity-0',
                                                  )}
                                                />
                                                <span className="italic">Custom</span>
                                              </CommandItem>
                                            )}
                                          </CommandGroup>
                                        )
                                      })()}
                                  </CommandList>
                                </div>
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

                {/* Warning when model lacks tool support */}
                {!supportsToolsSelected && (form.watch('model') || selectedModelId === 'custom') && (
                  <StatusCard
                    title={
                      <>
                        <X className="h-5 w-5 text-red-600" />
                        Model may not be compatible
                      </>
                    }
                    description="This model does not seem to support tool usage."
                  />
                )}

                {/* Test Connection Button */}
                {form.watch('model') && (
                  <Button
                    type="button"
                    onClick={testConnection}
                    disabled={isTestingConnection}
                    variant="outline"
                    className="w-full"
                  >
                    {isTestingConnection ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Testing Model...
                      </>
                    ) : (
                      'Test Model'
                    )}
                  </Button>
                )}

                {/* Connection Status Messages */}
                {connectionStatus === 'success' && (
                  <StatusCard
                    title={
                      <>
                        <Check className="h-5 w-5 text-green-600" />
                        Test successful!
                      </>
                    }
                    description="Successfully got a response from the model."
                    className="border-green-200/50 dark:border-green-500/20"
                  />
                )}

                {connectionStatus === 'error' && (
                  <StatusCard
                    title={
                      <>
                        <X className="h-5 w-5 text-red-600" />
                        Test failed
                      </>
                    }
                    description={connectionError || 'Received an error while testing the model.'}
                    className="bg-red-50/50 dark:bg-red-500/10 border-red-200/50 dark:border-red-500/20"
                  />
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
          </ResponsiveModalContent>
        </ResponsiveModal>
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
                    <div className="flex items-center justify-center bg-primary text-primary-foreground size-8 rounded-md font-medium flex-shrink-0">
                      {getProviderInitial(model.provider)}
                    </div>
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
                            <Switch
                              checked={isEnabled}
                              onCheckedChange={(checked) =>
                                toggleModelMutation.mutate({ id: model.id, enabled: checked })
                              }
                              className="cursor-pointer"
                            />
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
                      <Popover
                        open={deleteConfirmOpen === model.id}
                        onOpenChange={(open) =>
                          dispatch(
                            open
                              ? { type: 'OPEN_DELETE_CONFIRM', modelId: model.id }
                              : { type: 'CLOSE_DELETE_CONFIRM' },
                          )
                        }
                      >
                        <PopoverTrigger asChild>
                          <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-80" side="bottom" align="end">
                          <div className="space-y-3">
                            <div>
                              <h4 className="font-medium">Remove Model</h4>
                              <p className="text-sm text-muted-foreground">
                                Are you sure you want to remove this model? This action cannot be undone.
                              </p>
                            </div>
                            <div className="flex justify-end gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => dispatch({ type: 'CLOSE_DELETE_CONFIRM' })}
                              >
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
                    {model.provider === 'thunderbolt' && (
                      <div className="text-sm text-muted-foreground">Uses Thunderbolt cloud service</div>
                    )}
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
              <Button onClick={() => handleDialogOpenChange(true)} variant="outline">
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
