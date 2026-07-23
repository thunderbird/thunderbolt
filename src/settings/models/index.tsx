/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getTinfoilClient } from '@/ai/fetch'
import openAiLogoSrc from '@/assets/openai.svg'
import openRouterLogoSrc from '@/assets/openrouter.svg'
import tinfoilLogoSrc from '@/assets/tinfoil.svg'
import { AppLogo } from '@/components/app-logo'
import { DetailDivider, DetailPanel, DetailPanelSurface } from '@/components/detail-panel'
import { ModificationIndicator } from '@/components/modification-indicator'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button, mutedIconButtonClass } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Combobox, type ComboboxItem } from '@/components/ui/combobox'
import { needsApiKey } from '@/components/ui/model-selector/model-selector'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/page-header'
import { ResponsiveModalCancel, ResponsiveModalFooter } from '@/components/ui/responsive-modal'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { StatusCard } from '@/components/ui/status-card'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useDatabase } from '@/contexts'
import { createModel as createModelDAL, deleteModel, getAllModels, resetModelToDefault, updateModel } from '@/dal'
import { defaultModels } from '@shared/defaults/models'
import { isModelModified } from '@/defaults/utils'
import { fetch } from '@/lib/fetch'
import { normalizeOpenAiBaseUrl } from '@/lib/openai-base-url'
import { useModelConnectionTest } from '@/hooks/use-model-connection-test'
import { useIsMobile } from '@/hooks/use-mobile'
import type { Model } from '@/types'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation } from '@tanstack/react-query'
import { useQuery } from '@powersync/tanstack-react-query'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { http } from '@/lib/http'
import { PrivateBadge } from '@/components/ui/private-badge'
import { SiAnthropic } from '@icons-pack/react-simple-icons'
import { AlertTriangle, Check, Cpu, Loader2, MoreVertical, Plus, Server, SquarePen, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'

type AvailableModel = {
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
  isLoadingModels: boolean
  selectedModelId: string
  allAvailableModels: AvailableModel[]
  modelLoadError: string | null
}

type ModelAction =
  | { type: 'OPEN_DIALOG' }
  | { type: 'CLOSE_DIALOG' }
  | { type: 'FETCH_MODELS_START' }
  | { type: 'FETCH_MODELS_SUCCESS'; models: AvailableModel[] }
  | { type: 'FETCH_MODELS_FAILURE'; error: string }
  | { type: 'SELECT_MODEL'; modelId: string }
  | { type: 'PROVIDER_CHANGED' }
  | { type: 'OPEN_DELETE_CONFIRM'; modelId: string }
  | { type: 'CLOSE_DELETE_CONFIRM' }

const initialState: ModelState = {
  isAddDialogOpen: false,
  deleteConfirmOpen: null,
  isLoadingModels: false,
  selectedModelId: '',
  allAvailableModels: [],
  modelLoadError: null,
}

const modelReducer = (state: ModelState, action: ModelAction): ModelState => {
  switch (action.type) {
    case 'OPEN_DIALOG':
      // Fresh state every time the dialog is opened
      return { ...initialState, isAddDialogOpen: true }
    case 'CLOSE_DIALOG':
      return { ...initialState, isAddDialogOpen: false }

    case 'FETCH_MODELS_START':
      return {
        ...state,
        isLoadingModels: true,
        modelLoadError: null,
        allAvailableModels: [],
      }
    case 'FETCH_MODELS_SUCCESS':
      return {
        ...state,
        isLoadingModels: false,
        allAvailableModels: action.models,
      }
    case 'FETCH_MODELS_FAILURE':
      return {
        ...state,
        isLoadingModels: false,
        modelLoadError: action.error,
        allAvailableModels: [],
      }

    case 'SELECT_MODEL':
      return { ...state, selectedModelId: action.modelId }

    case 'PROVIDER_CHANGED':
      return {
        ...state,
        selectedModelId: '',
        allAvailableModels: [],
        modelLoadError: null,
        isLoadingModels: false,
      }

    case 'OPEN_DELETE_CONFIRM':
      return { ...state, deleteConfirmOpen: action.modelId }
    case 'CLOSE_DELETE_CONFIRM':
      return { ...state, deleteConfirmOpen: null }

    default:
      return state
  }
}

/**
 * Fetches the selectable model catalog for a provider. Providers without a
 * listable endpoint (thunderbolt, anthropic) return hardwired catalogs;
 * OpenAI-compatible providers require an API key (custom URLs may omit it)
 * and return [] when the credentials to list aren't available yet.
 */
const fetchModelsForProvider = async (provider: string, apiKey?: string, url?: string): Promise<AvailableModel[]> => {
  switch (provider) {
    case 'tinfoil': {
      // /v1/models is unauthenticated, but route through SecureClient so
      // attestation is warmed up before the user's first chat.
      const client = await getTinfoilClient()
      const response = await http.get(`${client.getBaseURL()}models`, { fetch: client.fetch }).json<{
        data: Array<AvailableModel & { endpoints?: string[]; tool_calling?: boolean }>
      }>()

      // The catalog also includes embedding, audio, document, and tts
      // models; filter to ones that expose chat completions.
      return (response.data || [])
        .filter((m) => Array.isArray(m.endpoints) && m.endpoints.includes('/v1/chat/completions'))
        .map((m) => ({ ...m, supports_tools: m.tool_calling === true }))
        .sort((a, b) => a.id.localeCompare(b.id))
    }
    case 'thunderbolt':
      return [
        { id: 'kimi-k2-instruct', name: 'Kimi K2', supports_tools: true },
        { id: 'deepseek-r1-0528', name: 'DeepSeek R1', supports_tools: true },
        { id: 'mistral-large-3', name: 'Mistral Large 3', supports_tools: true },
        { id: 'llama-v3p1-405b-instruct', name: 'Llama 3.1', supports_tools: true },
      ]
    case 'anthropic':
      return [
        { id: 'claude-opus-4-1-20250805', name: 'Claude Opus 4.1', supports_tools: true },
        { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', supports_tools: true },
        { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', supports_tools: true },
        { id: 'claude-3-7-sonnet-20250219', name: 'Claude Sonnet 3.7', supports_tools: true },
        { id: 'claude-3-5-sonnet-20241022', name: 'Claude Sonnet 3.5 (New)', supports_tools: true },
        { id: 'claude-3-5-haiku-20241022', name: 'Claude Haiku 3.5', supports_tools: true },
        { id: 'claude-3-5-sonnet-20240620', name: 'Claude Sonnet 3.5 (Old)', supports_tools: true },
        { id: 'claude-3-haiku-20240307', name: 'Claude Haiku 3', supports_tools: true },
        { id: 'claude-3-opus-20240229', name: 'Claude Opus 3', supports_tools: true },
      ]
  }

  const listing = ((): { endpoint: string; headers: Record<string, string> } | null => {
    switch (provider) {
      case 'openai':
        return apiKey
          ? { endpoint: 'https://api.openai.com/v1/models', headers: { Authorization: `Bearer ${apiKey}` } }
          : null
      case 'openrouter':
        return apiKey
          ? { endpoint: 'https://openrouter.ai/api/v1/models', headers: { Authorization: `Bearer ${apiKey}` } }
          : null
      case 'custom':
        // For Custom (OpenAI Compatible), try even without API key
        return url
          ? {
              endpoint: `${normalizeOpenAiBaseUrl(url)}/models`,
              headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
            }
          : null
      default:
        return null
    }
  })()

  if (!listing) {
    return []
  }

  const response = await http
    .get(listing.endpoint, { headers: listing.headers, fetch })
    .json<{ data: AvailableModel[] }>()

  return (response.data || [])
    .map((model) => {
      const supportedParameters = model.supported_parameters ?? []
      const supportsToolsByParams = supportedParameters.includes('tools') || supportedParameters.includes('tool_choice')

      return { ...model, supports_tools: model.supports_tools === true || supportsToolsByParams }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** Maps a catalog-fetch failure to the user-facing message shown in the form. */
const describeModelFetchError = (error: unknown): string => {
  // Browser/network failure (could be offline, CORS, cert error, etc.)
  if (error instanceof TypeError) {
    return 'Network request failed (the browser blocked the request or the server is unreachable).'
  }
  // HttpError with a Response object
  if (typeof error === 'object' && error && 'response' in error) {
    const response = (error as { response?: Response }).response
    return response
      ? `Server responded with status ${response.status} ${response.statusText}`
      : 'Server responded with an unknown error.'
  }
  if (error instanceof Error && error.message) {
    return error.message
  }
  return 'Failed to load models'
}

/**
 * Thunderbolt uses the app's authenticated cloud endpoint — no user-supplied
 * credentials to verify — so Save is not gated on a live test. Every other
 * provider requires a passing connection test before Save is enabled.
 */
const providerRequiresConnectionTest = (provider: Model['provider']) => provider !== 'thunderbolt'

/** System-managed Tinfoil is a Thunderbolt product; Tinfoil is only its transport. */
const isThunderboltManagedModel = (model: Pick<Model, 'provider' | 'isSystem'>) =>
  model.provider === 'thunderbolt' || (model.provider === 'tinfoil' && model.isSystem === 1)

/** Returns the public provider mark shown in model rows and detail headers. */
const ModelProviderIcon = ({ model }: { model: Pick<Model, 'provider' | 'isSystem'> }) => {
  if (isThunderboltManagedModel(model)) {
    return <AppLogo size={20} alt="" />
  }

  switch (model.provider) {
    case 'thunderbolt':
      return <AppLogo size={20} alt="" />
    case 'openai':
      return <img src={openAiLogoSrc} alt="" className="size-5 dark:invert" />
    case 'anthropic':
      return <SiAnthropic size={20} aria-hidden="true" />
    case 'openrouter':
      return <img src={openRouterLogoSrc} alt="" className="h-5 w-auto dark:invert" />
    case 'tinfoil':
      return <img src={tinfoilLogoSrc} alt="" className="size-5 dark:invert" />
    case 'custom':
      return <Server className="size-5 text-muted-foreground" aria-hidden="true" />
  }
}

const ModelProviderIconTile = ({ model }: { model: Pick<Model, 'provider' | 'isSystem'> }) => (
  <div className="flex aspect-square size-9 shrink-0 items-center justify-center rounded-md bg-muted text-foreground">
    <ModelProviderIcon model={model} />
  </div>
)

/** Determines whether the add-model form has completed every submission gate. */
export const shouldDisableAddModel = (
  isPending: boolean,
  isFormValid: boolean,
  requiresConnectionTest: boolean,
  isConnectionSuccessful: boolean,
) => isPending || !isFormValid || (requiresConnectionTest && !isConnectionSuccessful)

/**
 * Providers that need an API key to authenticate the test round-trip. Custom
 * (OpenAI-compatible) endpoints may or may not need one, so the key is treated
 * as optional there.
 */
const providerRequiresApiKey = (provider: Model['provider']) => provider !== 'thunderbolt' && provider !== 'custom'

const canTestModelConnection = (provider: Model['provider'], model?: string, apiKey?: string | null) => {
  if (!providerRequiresConnectionTest(provider)) {
    return false
  }
  if (!model) {
    return false
  }
  if (providerRequiresApiKey(provider)) {
    return !!apiKey
  }
  return true
}

type ConnectionTestSectionProps = {
  provider: Model['provider']
  model: string
  apiKey: string | undefined
  isTesting: boolean
  onTest: () => void
  status: 'idle' | 'success' | 'error'
  error: string | null
}

/**
 * Test-Model button, success/error status cards, and the "enter an API key"
 * hint — shared by the Add and Edit dialogs so the display stays in sync.
 */
const ConnectionTestSection = ({
  provider,
  model,
  apiKey,
  isTesting,
  onTest,
  status,
  error,
}: ConnectionTestSectionProps) => {
  const canTest = canTestModelConnection(provider, model, apiKey)
  const showApiKeyHint = !canTest && !!model && providerRequiresApiKey(provider)

  return (
    <>
      {canTest && (
        <Button type="button" onClick={onTest} disabled={isTesting} variant="outline" className="w-full">
          {isTesting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Testing Model...
            </>
          ) : (
            'Test Model'
          )}
        </Button>
      )}

      {showApiKeyHint && (
        <p className="text-sm text-muted-foreground text-center">
          Enter an API key to test the connection before saving.
        </p>
      )}

      {status === 'success' && (
        <StatusCard
          title={
            <>
              <Check className="h-5 w-5 text-success" />
              Test successful!
            </>
          }
          description="Successfully got a response from the model."
        />
      )}

      {status === 'error' && (
        <StatusCard
          title={
            <>
              <X className="h-5 w-5 text-destructive" />
              Test failed
            </>
          }
          description={error || 'Received an error while testing the model.'}
        />
      )}
    </>
  )
}

const formSchema = z
  .object({
    provider: z.enum(['thunderbolt', 'anthropic', 'openai', 'custom', 'openrouter', 'tinfoil']),
    name: z.string().min(1, { message: 'Name is required.' }),
    model: z.string().min(1, { message: 'Model name is required.' }),
    customModel: z.string().optional(),
    url: z.string().optional(),
    apiKey: z.string().optional(),
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
      if (data.provider === 'thunderbolt') {
        return true // API key not required for thunderbolt
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

const editFormSchema = z.object({
  name: z.string().min(1, { message: 'Name is required.' }),
  model: z.string().min(1, { message: 'Model name is required.' }),
  url: z.string().optional(),
  apiKey: z.string().optional(),
})

const buildEditFormSchema = (provider: Model['provider']) =>
  editFormSchema.refine((data) => provider !== 'custom' || (!!data.url && data.url.length > 0), {
    message: 'URL is required for Custom providers',
    path: ['url'],
  })

const EditModelForm = ({
  model,
  onCancel,
  onSubmit,
  isPending,
}: {
  model: Model
  onCancel: () => void
  onSubmit: (values: z.infer<typeof editFormSchema> & { id: string }) => void
  isPending: boolean
}) => {
  const form = useForm<z.infer<typeof editFormSchema>>({
    resolver: zodResolver(buildEditFormSchema(model.provider)),
    defaultValues: {
      name: model.name || '',
      model: model.model,
      url: model.url || '',
      // The stored key never round-trips into the field — a masked
      // placeholder stands in for it, and an empty draft means "keep it".
      apiKey: '',
    },
  })

  const watchedModel = form.watch('model')
  const watchedUrl = form.watch('url')
  const watchedApiKey = form.watch('apiKey')
  // Blank key field falls back to the stored key (for listing, testing, and
  // saving) so editing other fields never requires re-entering the secret.
  const effectiveApiKey = watchedApiKey || model.apiKey || undefined

  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([])
  const [isCustomModel, setIsCustomModel] = useState(false)

  // Async catalog load on mount, keyed by the model being edited (the form
  // remounts per model via `key={model.id}`).
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const catalog = await fetchModelsForProvider(model.provider, model.apiKey ?? undefined, model.url ?? undefined)
        if (!cancelled) {
          setAvailableModels(catalog)
        }
      } catch (error) {
        // Selector falls back to the stored model + free-text Custom entry.
        console.error('Failed to fetch models:', error)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [model])

  const modelItems = useMemo((): ComboboxItem[] => {
    const items: ComboboxItem[] = availableModels.map((m) => ({
      id: m.id,
      label: m.name || m.id,
      description: m.name ? m.id : undefined,
    }))
    if (!availableModels.some((m) => m.id === model.model)) {
      items.unshift({ id: model.model, label: model.model })
    }
    items.push({ id: 'custom', label: 'Custom' })
    return items
  }, [availableModels, model.model])

  const handleModelSelect = (id: string) => {
    if (id === 'custom') {
      setIsCustomModel(true)
      return
    }
    setIsCustomModel(false)
    form.setValue('model', id, { shouldValidate: true, shouldDirty: true })
  }

  const {
    isTesting,
    status: connectionStatus,
    error: connectionError,
    test,
  } = useModelConnectionTest({
    provider: model.provider,
    model: watchedModel,
    url: watchedUrl,
    apiKey: effectiveApiKey,
  })

  const handleSubmit = (values: z.infer<typeof editFormSchema>) => {
    onSubmit({ ...values, apiKey: values.apiKey || model.apiKey || '', id: model.id })
  }

  const handleTest = () => {
    const values = form.getValues()
    test({
      provider: model.provider,
      model: values.model,
      url: values.url,
      apiKey: values.apiKey || model.apiKey || undefined,
    })
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="flex flex-1 flex-col gap-4 pt-4 pb-2">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input {...field} className="rounded-lg" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="model"
          render={({ field }) => (
            <FormItem className="flex flex-col">
              <FormLabel>Model</FormLabel>
              <FormControl>
                {isCustomModel ? (
                  <Input {...field} placeholder="e.g., gpt-4-turbo-preview" className="rounded-lg" />
                ) : (
                  <Combobox
                    items={modelItems}
                    value={watchedModel}
                    onValueChange={handleModelSelect}
                    placeholder="Select model..."
                    searchPlaceholder="Search models..."
                    emptyMessage="No models found."
                  />
                )}
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {model.provider === 'custom' && (
          <FormField
            control={form.control}
            name="url"
            render={({ field }) => (
              <FormItem>
                <FormLabel>URL</FormLabel>
                <FormControl>
                  <Input {...field} className="rounded-lg" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        {model.provider !== 'thunderbolt' && (
          <FormField
            control={form.control}
            name="apiKey"
            render={({ field }) => (
              <FormItem>
                <FormLabel>API Key</FormLabel>
                <FormControl>
                  <Input
                    type="password"
                    {...field}
                    placeholder={model.apiKey ? '••••••••••••••••' : 'sk-...'}
                    className="rounded-lg"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        <ConnectionTestSection
          provider={model.provider}
          model={watchedModel}
          apiKey={effectiveApiKey}
          isTesting={isTesting}
          onTest={handleTest}
          status={connectionStatus}
          error={connectionError}
        />

        <ResponsiveModalFooter>
          <ResponsiveModalCancel onClick={onCancel} />
          <Button
            type="submit"
            disabled={
              isPending ||
              !form.formState.isDirty ||
              (providerRequiresConnectionTest(model.provider) && connectionStatus !== 'success')
            }
          >
            Save
          </Button>
        </ResponsiveModalFooter>
      </form>
    </Form>
  )
}

/** Copy shown in the actions menu for built-in models. Exported for unit tests. */
export const systemModelMenuMessage = "Built-in models can't be edited or removed"

export default function ModelsPage() {
  const db = useDatabase()
  const { isMobile } = useIsMobile()
  const [state, dispatch] = useReducer(modelReducer, initialState)
  const [editingModel, setEditingModel] = useState<Model | null>(null)
  const [activeModelId, setActiveModelId] = useState<string | null>(null)
  const { isAddDialogOpen, deleteConfirmOpen, isLoadingModels, selectedModelId, allAvailableModels, modelLoadError } =
    state

  const { data: models = [] } = useQuery({
    queryKey: ['models'],
    query: toCompilableQuery(getAllModels(db)),
  })
  const activeModel = models.find((model) => model.id === activeModelId)

  const toggleModelMutation = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      await updateModel(db, id, { enabled: enabled ? 1 : 0 })
    },
  })

  const addModelMutation = useMutation({
    mutationFn: async (values: z.infer<typeof formSchema>) => {
      await createModelDAL(db, {
        id: uuidv7(),
        ...values,
        apiKey: values.apiKey || null,
        url: values.url || null,
        isSystem: 0,
        enabled: 1,
        // Tool use is always on for user-added models; the form no longer
        // exposes a toggle (the compatibility warning below the model picker
        // still flags models that may not support it).
        toolUsage: 1,
        contextWindow: null,
      })
    },
    onSuccess: () => {
      form.reset()
      form.clearErrors()
      dispatch({ type: 'CLOSE_DIALOG' })
    },
  })

  const deleteModelMutation = useMutation({
    mutationFn: async (id: string) => {
      await deleteModel(db, id)
    },
    onSuccess: () => {
      dispatch({ type: 'CLOSE_DELETE_CONFIRM' })
    },
  })

  const editModelMutation = useMutation({
    mutationFn: async (values: z.infer<typeof editFormSchema> & { id: string }) => {
      const { id, ...fields } = values
      await updateModel(db, id, {
        ...fields,
        apiKey: fields.apiKey || null,
        url: fields.url || null,
      })
    },
    onSuccess: () => {
      setEditingModel(null)
    },
  })

  const resetModelMutation = useMutation({
    mutationFn: async (id: string) => {
      const defaultModel = defaultModels.find((m) => m.id === id)
      if (!defaultModel) {
        // Retired system model: no default left to restore to. Soft-delete
        // the row so users can clear stuck retired-and-modified entries that
        // `cleanupRemovedDefaults` skipped (hash mismatch = "modified").
        await deleteModel(db, id)
        return
      }
      await resetModelToDefault(db, id, defaultModel)
    },
  })

  const handleResetModel = (id: string) => {
    resetModelMutation.mutate(id)
  }

  type FormData = z.infer<typeof formSchema>

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    mode: 'onChange',
    defaultValues: {
      provider: 'thunderbolt',
      name: '',
      model: '',
      customModel: '',
      url: '',
      apiKey: '',
    },
  })

  const onSubmit = (values: z.infer<typeof formSchema>) => {
    // Use customModel if it's a custom selection, otherwise use model
    const modelId = selectedModelId === 'custom' && values.customModel ? values.customModel : values.model

    addModelMutation.mutate({
      ...values,
      model: modelId,
    })
  }

  const testConnection = () => {
    const values = form.getValues()
    const modelId = selectedModelId === 'custom' && values.customModel ? values.customModel : values.model
    runConnectionTest({
      provider: values.provider,
      model: modelId,
      url: values.url,
      apiKey: values.apiKey,
    })
  }

  const handleDialogOpenChange = (open: boolean) => {
    if (open) {
      // The add form takes over the shared panel surface — close any open
      // model detail / edit view so the two never contend for it.
      setActiveModelId(null)
      setEditingModel(null)
      dispatch({ type: 'OPEN_DIALOG' })
      resetConnectionTest()

      if (form.getValues('provider') === 'thunderbolt' && allAvailableModels.length === 0) {
        fetchAvailableModels('thunderbolt')
      }
    } else {
      form.reset()
      form.clearErrors()
      dispatch({ type: 'CLOSE_DIALOG' })
      resetConnectionTest()
    }
  }

  const fetchAvailableModels = async (provider: string, apiKey?: string, url?: string) => {
    dispatch({ type: 'FETCH_MODELS_START' })
    try {
      // An empty catalog (missing credentials) keeps the previous UI: the
      // model picker simply doesn't render until the key/URL is supplied.
      dispatch({ type: 'FETCH_MODELS_SUCCESS', models: await fetchModelsForProvider(provider, apiKey, url) })
    } catch (error) {
      console.error('Failed to fetch models:', error)
      dispatch({ type: 'FETCH_MODELS_FAILURE', error: describeModelFetchError(error) })
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
      form.setValue('model', '', { shouldValidate: true })
      form.setValue('customModel', '')
      form.setValue('name', '', { shouldValidate: true })
    } else {
      form.setValue('model', modelId, { shouldValidate: true })
      form.setValue('customModel', '')

      const model = allAvailableModels.find((m) => m.id === modelId)

      if (model?.name) {
        form.setValue('name', model.name, { shouldValidate: true })
      } else {
        // Generate a name locally
        const generatedName = generateModelName(modelId)
        form.setValue('name', generatedName, { shouldValidate: true })
      }
    }
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
      void form.trigger()

      // Fetch models if we have the necessary credentials
      if (['thunderbolt', 'tinfoil', 'anthropic'].includes(currentProvider)) {
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

    if (
      provider &&
      (['thunderbolt', 'anthropic'].includes(provider) || (provider && apiKey) || (provider === 'custom' && url))
    ) {
      fetchAvailableModels(provider, apiKey, url)
    }
  }, [watchedApiKey, watchedUrl, form])

  const getProviderDisplay = (model: Model) => {
    if (isThunderboltManagedModel(model)) {
      return 'Thunderbolt'
    }

    switch (model.provider) {
      case 'thunderbolt':
        return 'Thunderbolt'
      case 'tinfoil':
        return 'Tinfoil'
      case 'anthropic':
        return 'Anthropic'
      case 'openai':
        return 'OpenAI'
      case 'custom':
        return 'Custom'
      case 'openrouter':
        return 'OpenRouter'
      default:
        return model.provider
    }
  }

  const handleDeleteModel = (modelId: string) => {
    deleteModelMutation.mutate(modelId)
  }

  const comboboxItems = useMemo((): ComboboxItem[] => {
    const items: ComboboxItem[] = allAvailableModels.map((model) => ({
      id: model.id,
      label: model.name || model.id,
      description: model.name ? model.id : undefined,
    }))
    if (watchedProvider !== 'thunderbolt') {
      items.push({ id: 'custom', label: 'Custom' })
    }
    return items
  }, [allAvailableModels, watchedProvider])

  // Calculate whether the currently selected model supports tools
  const supportsToolsSelected = (() => {
    if (!selectedModelId || selectedModelId === 'custom') {
      return true
    }
    const model = allAvailableModels.find((m) => m.id === selectedModelId)
    return model?.supports_tools === true
  })()

  const watchedModel = form.watch('model')

  const {
    isTesting: isTestingConnection,
    status: connectionStatus,
    error: connectionError,
    test: runConnectionTest,
    reset: resetConnectionTest,
  } = useModelConnectionTest({
    provider: watchedProvider,
    model: watchedModel,
    url: watchedUrl,
    apiKey: watchedApiKey,
  })

  // The add form renders inside the shared detail-panel surface (same aside
  // idiom as the skills create form), so it's built here and slotted into the
  // surface below.
  const addModelForm = (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-1 flex-col gap-4 pt-4 pb-2">
        <FormField
          control={form.control}
          name="provider"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Provider</FormLabel>
              <FormControl>
                <Select onValueChange={field.onChange} value={field.value}>
                  <SelectTrigger className="w-full rounded-lg">
                    <SelectValue placeholder="Select provider" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="thunderbolt">Thunderbolt</SelectItem>
                    <SelectItem value="tinfoil">Tinfoil</SelectItem>
                    <SelectItem value="openai">OpenAI</SelectItem>
                    <SelectItem value="openrouter">OpenRouter</SelectItem>
                    <SelectItem value="anthropic">Anthropic</SelectItem>
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
                    <Input {...field} placeholder="http://localhost:11434/v1" className="pr-10 rounded-lg" />
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
                  <Input type="password" {...field} placeholder="sk-..." className="rounded-lg" />
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
          // 1. Thunderbolt / Tinfoil (no API key needed)
          // 1. Anthropic (API key required for testing - model list is hardwired)
          // 2. Other providers with API key
          // 3. OpenAI Compatible with URL (API key optional)
          const showModelSelection =
            !modelLoadError &&
            (['thunderbolt', 'tinfoil', 'anthropic'].includes(provider) ||
              (provider && apiKey) ||
              (provider === 'custom' && url))

          if (!showModelSelection) {
            return null
          }

          return (
            <FormField
              control={form.control}
              name="model"
              render={() => (
                <FormItem className="flex flex-col">
                  <FormLabel>Model</FormLabel>
                  <FormControl>
                    <Combobox
                      items={comboboxItems}
                      value={selectedModelId || undefined}
                      onValueChange={(id) => handleSelectModel(id)}
                      placeholder="Select model..."
                      searchPlaceholder="Search models..."
                      emptyMessage="No models found."
                      loading={isLoadingModels}
                    />
                  </FormControl>
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
                    className="rounded-lg"
                    onChange={(e) => {
                      field.onChange(e)
                      form.setValue('model', e.target.value, { shouldValidate: true })
                    }}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        {/* Display Name - Only show when model is selected */}
        {(watchedModel || selectedModelId === 'custom') && (
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Display Name</FormLabel>
                <FormControl>
                  <Input {...field} placeholder="e.g., GPT-4 Turbo" className="rounded-lg" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        {/* Warning when model lacks tool support */}
        {!supportsToolsSelected && (watchedModel || selectedModelId === 'custom') && (
          <StatusCard
            title={
              <>
                <X className="h-5 w-5 text-warning" />
                Model may not be compatible
              </>
            }
            description="This model does not seem to support tool usage."
          />
        )}

        <ConnectionTestSection
          provider={watchedProvider}
          model={watchedModel}
          apiKey={watchedApiKey}
          isTesting={isTestingConnection}
          onTest={testConnection}
          status={connectionStatus}
          error={connectionError}
        />

        <ResponsiveModalFooter>
          <ResponsiveModalCancel onClick={() => handleDialogOpenChange(false)} />
          <Button
            type="submit"
            disabled={shouldDisableAddModel(
              addModelMutation.isPending,
              form.formState.isValid,
              providerRequiresConnectionTest(watchedProvider),
              connectionStatus === 'success',
            )}
          >
            {addModelMutation.isPending ? 'Adding...' : 'Add Model'}
          </Button>
        </ResponsiveModalFooter>
      </form>
    </Form>
  )

  return (
    <div className="relative flex h-full">
      <div className="min-w-0 flex-1 overflow-hidden">
        {/* md:min-w mirrors the agents page: once the aside squeezes the list
            to this floor, the whole column (header buttons included) stops
            sliding and tucks under the panel via the parent's overflow clip. */}
        <div className="mx-auto flex h-full w-full max-w-[760px] flex-col gap-6 overflow-y-auto p-4 pb-12 md:min-w-[360px] md:px-5">
          <PageHeader title="Models">
            <Button
              variant="outline"
              size="icon"
              className="bg-card"
              aria-label="Add model"
              onClick={() => handleDialogOpenChange(true)}
            >
              <Plus />
            </Button>
          </PageHeader>

          <div className="grid gap-4">
            {models.map((model) => {
              const isEnabled = model.enabled === 1
              const isSelected = activeModel?.id === model.id

              return (
                <Card
                  key={model.id}
                  onClick={() => {
                    // A row tap claims the panel: dismiss the add form and any
                    // in-progress edit before toggling this model's detail.
                    if (isAddDialogOpen) {
                      handleDialogOpenChange(false)
                    }
                    setEditingModel(null)
                    setActiveModelId((current) => (current === model.id ? null : model.id))
                  }}
                  className={
                    isSelected
                      ? 'flex-row items-center gap-0 border-border bg-accent p-0'
                      : 'flex-row items-center gap-0 border-border p-0 transition-colors hover:bg-secondary/50'
                  }
                >
                  <button
                    type="button"
                    aria-label={`Open ${model.name}`}
                    aria-pressed={isSelected}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-l-[inherit] px-4 py-3 text-left"
                  >
                    <ModelProviderIconTile model={model} />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2 truncate text-base font-medium">
                        {needsApiKey(model) && (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
                              </TooltipTrigger>
                              <TooltipContent side="bottom">
                                <p>API key not configured</p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                        <span className="truncate">{model.name}</span>
                        {!!model.isConfidential && <PrivateBadge />}
                      </div>
                      <p className="truncate text-[length:var(--font-size-sm)] text-muted-foreground">
                        {getProviderDisplay(model)}
                      </p>
                    </div>
                  </button>
                  <div className="flex shrink-0 items-center pr-4">
                    <Switch
                      checked={isEnabled}
                      onClick={(event) => event.stopPropagation()}
                      onCheckedChange={(checked) => toggleModelMutation.mutate({ id: model.id, enabled: checked })}
                      className="cursor-pointer"
                      aria-label={isEnabled ? `Disable ${model.name}` : `Enable ${model.name}`}
                    />
                  </div>
                </Card>
              )
            })}

            {models.length === 0 && (
              <Card className="border-dashed border-2 border-muted-foreground/25">
                <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                  <Cpu className="size-10 text-muted-foreground mb-4" />
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
      </div>

      <DetailPanelSurface
        open={isAddDialogOpen || activeModel !== undefined}
        isMobile={isMobile}
        onClose={() => {
          if (isAddDialogOpen) {
            handleDialogOpenChange(false)
          }
          setEditingModel(null)
          setActiveModelId(null)
        }}
      >
        {isAddDialogOpen ? (
          <DetailPanel title="Add Model" onClose={() => handleDialogOpenChange(false)}>
            {addModelForm}
          </DetailPanel>
        ) : activeModel && editingModel ? (
          <DetailPanel title="Edit Model" subtitle={editingModel.name} onClose={() => setEditingModel(null)}>
            <EditModelForm
              key={editingModel.id}
              model={editingModel}
              onCancel={() => setEditingModel(null)}
              onSubmit={(values) => editModelMutation.mutate(values)}
              isPending={editModelMutation.isPending}
            />
          </DetailPanel>
        ) : activeModel ? (
          <DetailPanel
            icon={<ModelProviderIconTile model={activeModel} />}
            title={activeModel.name}
            subtitle={getProviderDisplay(activeModel)}
            actions={
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="More" className={mutedIconButtonClass}>
                    <MoreVertical />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-56">
                  {activeModel.isSystem === 1 ? (
                    <div className="px-2 py-1.5 text-[length:var(--font-size-sm)] text-muted-foreground">
                      {systemModelMenuMessage}
                    </div>
                  ) : (
                    <>
                      <DropdownMenuItem onClick={() => setEditingModel(activeModel)} className="cursor-pointer">
                        <SquarePen />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => dispatch({ type: 'OPEN_DELETE_CONFIRM', modelId: activeModel.id })}
                        className="cursor-pointer"
                      >
                        <Trash2 />
                        Delete
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            }
            onClose={() => setActiveModelId(null)}
          >
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium text-muted-foreground">Model</p>
                <p className="truncate text-base text-foreground">{activeModel.model}</p>
              </div>
              {activeModel.url && (
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-medium text-muted-foreground">URL</p>
                  <p className="truncate text-base text-foreground">{activeModel.url}</p>
                </div>
              )}
              {!!activeModel.isConfidential && (
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-medium text-muted-foreground">Privacy</p>
                  <div>
                    <PrivateBadge />
                  </div>
                </div>
              )}
            </div>

            {needsApiKey(activeModel) && (
              <>
                <DetailDivider />
                <div className="flex items-center gap-2 text-sm text-amber-600">
                  <AlertTriangle className="size-4 shrink-0" />
                  API key not configured
                </div>
              </>
            )}

            {isModelModified(activeModel) && (
              <>
                <DetailDivider />
                <ModificationIndicator
                  hasModifications
                  onReset={() => handleResetModel(activeModel.id)}
                  customMessage="You've customized this model."
                  ariaLabel="Modified model"
                  requireConfirmation={false}
                >
                  Customized model
                </ModificationIndicator>
              </>
            )}
          </DetailPanel>
        ) : null}
      </DetailPanelSurface>

      {/* Delete Confirmation */}
      <AlertDialog
        open={!!deleteConfirmOpen}
        onOpenChange={(open) => !open && dispatch({ type: 'CLOSE_DELETE_CONFIRM' })}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Model</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove this model? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteModelMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteConfirmOpen) {
                  handleDeleteModel(deleteConfirmOpen)
                }
              }}
              disabled={deleteModelMutation.isPending}
              variant="destructive"
            >
              {deleteModelMutation.isPending ? 'Removing...' : 'Remove'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
