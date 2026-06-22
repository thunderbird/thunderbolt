/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createModel, getTinfoilClient } from '@/ai/fetch'
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
import { Button } from '@/components/ui/button'
import { ButtonGroup, ButtonGroupItem } from '@/components/ui/button-group'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Combobox, type ComboboxItem } from '@/components/ui/combobox'
import { needsApiKey } from '@/components/ui/model-selector/model-selector'
import { Dialog, DialogTrigger } from '@/components/ui/dialog'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/page-header'
import {
  ResponsiveModalContentComposable,
  ResponsiveModalDescription,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from '@/components/ui/responsive-modal'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { StatusCard } from '@/components/ui/status-card'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useDatabase } from '@/contexts'
import { ScopePicker } from '@/components/scope-picker'
import { ScopeBadge } from '@/components/scope-badge'
import { useScopePickerEnabled } from '@/hooks/use-scope-picker-enabled'
import { useTrustDomainRegistry } from '@/stores/trust-domain-registry'
import { useActiveWorkspaceId } from '@/lib/active-workspace'
import { useWorkspacePermission as useWorkspacePermission_default } from '@/hooks/use-workspace-permission'
import { createModel as createModelDAL, deleteModel, getAllModels, resetModelToDefault, updateModel } from '@/dal'
import { defaultModels } from '@/defaults/models'
import { isModelModified } from '@/defaults/utils'
import { fetch } from '@/lib/fetch'
import { useProxyFetchGetter } from '@/lib/proxy-fetch-context'
import type { Model } from '@/types'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation } from '@tanstack/react-query'
import { useQuery } from '@powersync/tanstack-react-query'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { generateText } from 'ai'
import { http } from '@/lib/http'
import { AlertTriangle, Check, Cpu, Loader2, Lock, Pen, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent } from 'react'
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
  isTestingConnection: boolean
  connectionStatus: 'idle' | 'success' | 'error'
  connectionError: string | null
  isLoadingModels: boolean
  selectedModelId: string
  allAvailableModels: AvailableModel[]
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
    provider: z.enum(['thunderbolt', 'anthropic', 'openai', 'custom', 'openrouter', 'tinfoil']),
    name: z.string().min(1, { message: 'Name is required.' }),
    model: z.string().min(1, { message: 'Model name is required.' }),
    customModel: z.string().optional(),
    url: z.string().optional(),
    apiKey: z.string().optional(),
    toolUsage: z.boolean(),
    scope: z.enum(['workspace', 'user']),
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
  scope: z.enum(['workspace', 'user']),
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
  showScopePicker = false,
}: {
  model: Model
  onCancel: () => void
  onSubmit: (values: z.infer<typeof editFormSchema> & { id: string }) => void
  isPending: boolean
  /** Mount the scope picker (THU-603). Parent computes this as
   *  `scopePickerEnabled && active.userId === currentUserId` — i.e. only the
   *  row's author sees it in edit mode. Same pattern as `SkillForm` so the
   *  ownership rule looks identical across resources. */
  showScopePicker?: boolean
}) => {
  const form = useForm<z.infer<typeof editFormSchema>>({
    resolver: zodResolver(buildEditFormSchema(model.provider)),
    defaultValues: {
      name: model.name || '',
      model: model.model || '',
      url: model.url || '',
      apiKey: model.apiKey || '',
      scope: model.scope ?? 'workspace',
    },
  })

  const handleSubmit = (values: z.infer<typeof editFormSchema>) => {
    onSubmit({ ...values, id: model.id })
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="grid gap-4 pt-4 pb-2">
        {showScopePicker && (
          <FormField
            control={form.control}
            name="scope"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <ScopePicker id="edit-model-scope" value={field.value} onChange={field.onChange} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}
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
            <FormItem>
              <FormLabel>Model</FormLabel>
              <FormControl>
                <Input {...field} className="rounded-lg" />
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
                  <Input type="password" {...field} placeholder="sk-..." className="rounded-lg" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        <div className="flex justify-end gap-3 pt-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={isPending || !form.formState.isDirty}>
            Save
          </Button>
        </div>
      </form>
    </Form>
  )
}

const EditModelModal = ({
  model,
  onOpenChange,
  onSubmit,
  isPending,
  showScopePicker,
}: {
  model: Model | null
  onOpenChange: (open: boolean) => void
  onSubmit: (values: z.infer<typeof editFormSchema> & { id: string }) => void
  isPending: boolean
  showScopePicker?: boolean
}) => (
  <Dialog open={!!model} onOpenChange={onOpenChange}>
    <ResponsiveModalContentComposable className="sm:max-w-[500px]">
      <ResponsiveModalHeader>
        <ResponsiveModalTitle>Edit Model</ResponsiveModalTitle>
        <ResponsiveModalDescription className="sr-only">Edit model configuration</ResponsiveModalDescription>
      </ResponsiveModalHeader>
      {model && (
        <EditModelForm
          key={model.id}
          model={model}
          onCancel={() => onOpenChange(false)}
          onSubmit={onSubmit}
          isPending={isPending}
          showScopePicker={showScopePicker}
        />
      )}
    </ResponsiveModalContentComposable>
  </Dialog>
)

type ModelsPageProps = {
  /** Test seam — defaults to the real hook. Tests inject a fake to drive the
   *  gated Add/Edit/Delete affordances. */
  useWorkspacePermission?: typeof useWorkspacePermission_default
}

export default function ModelsPage({ useWorkspacePermission = useWorkspacePermission_default }: ModelsPageProps = {}) {
  const db = useDatabase()
  const workspaceId = useActiveWorkspaceId()
  const currentUserId = useTrustDomainRegistry((state) => {
    if (state.activeTrustDomain?.kind === 'standalone') {
      return state.localUserId
    }
    if (state.activeTrustDomain?.kind === 'server') {
      return state.servers[state.activeTrustDomain.serverId]?.userId
    }
    return undefined
  })
  const scopePickerEnabled = useScopePickerEnabled()
  const getProxyFetch = useProxyFetchGetter()
  const [state, dispatch] = useReducer(modelReducer, initialState)
  const [editingModel, setEditingModel] = useState<Model | null>(null)
  // Workspace `add_models` / `remove_models` — BE enforces; FE hides
  // affordances so the user isn't presented with actions that round-trip-fail.
  const { isAllowed: canAddModels } = useWorkspacePermission('add_models')
  const { isAllowed: canRemoveModels } = useWorkspacePermission('remove_models')
  const {
    isAddDialogOpen,
    deleteConfirmOpen,
    isTestingConnection,
    connectionStatus,
    connectionError,
    isLoadingModels,
    selectedModelId,
    allAvailableModels,
    modelLoadError,
  } = state

  const { data: models = [] } = useQuery({
    queryKey: ['models', workspaceId],
    query: toCompilableQuery(getAllModels(db, workspaceId ?? '')),
    enabled: !!workspaceId,
  })

  const toggleModelMutation = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      if (!workspaceId) {
        throw new Error('No active workspace')
      }
      await updateModel(db, workspaceId, id, { enabled: enabled ? 1 : 0 })
    },
  })

  const addModelMutation = useMutation({
    mutationFn: async (values: z.infer<typeof formSchema>) => {
      if (!workspaceId) {
        throw new Error('No active workspace')
      }
      await createModelDAL(db, workspaceId, {
        id: uuidv7(),
        ...values,
        apiKey: values.apiKey || null,
        url: values.url || null,
        isSystem: 0,
        enabled: 1,
        toolUsage: values.toolUsage ? 1 : 0,
        contextWindow: null,
        // Pass through the picker's scope when it was mounted; userId stamps
        // the row's author so 'user' scope syncs into the per-user bucket.
        scope: scopePickerEnabled ? values.scope : 'workspace',
        userId: currentUserId ?? null,
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
      if (!workspaceId) {
        throw new Error('No active workspace')
      }
      await deleteModel(db, workspaceId, id)
    },
    onSuccess: () => {
      dispatch({ type: 'CLOSE_DELETE_CONFIRM' })
    },
  })

  const editModelMutation = useMutation({
    mutationFn: async (values: z.infer<typeof editFormSchema> & { id: string }) => {
      if (!workspaceId) {
        throw new Error('No active workspace')
      }
      const { id, ...fields } = values
      // `scope` flows through to updateModel — BE handler applies it for the
      // row's owner and silently drops it for non-owners.
      await updateModel(db, workspaceId, id, {
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
      if (!workspaceId) {
        throw new Error('No active workspace')
      }
      const defaultModel = defaultModels.find((m) => m.id === id)
      if (!defaultModel) {
        throw new Error('Model is not a default model')
      }
      await resetModelToDefault(db, workspaceId, id, defaultModel)
    },
  })

  const handleResetModel = (id: string) => {
    resetModelMutation.mutate(id)
  }

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
      scope: 'workspace',
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
        supportsParallelToolCalls: 1,
        contextWindow: null,
        tokenizer: null,
        deletedAt: null,
        defaultHash: null, // User-created, not based on a default
        vendor: null,
        description: null,
        userId: null,
        workspaceId: null,
        scope: 'workspace' as const,
      }
      const model = await createModel(modelConfigWithDefaults, getProxyFetch)

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
      dispatch({ type: 'OPEN_DIALOG' })

      if (form.getValues('provider') === 'thunderbolt' && allAvailableModels.length === 0) {
        fetchAvailableModels('thunderbolt')
      }
    } else {
      form.reset()
      form.clearErrors()
      dispatch({ type: 'CLOSE_DIALOG' })
    }
  }

  const handleKeyDown = (e: KeyboardEvent) => {
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
        case 'tinfoil': {
          // /v1/models is unauthenticated, but route through SecureClient so
          // attestation is warmed up before the user's first chat.
          const client = await getTinfoilClient()
          const response = await http.get(`${client.getBaseURL()}models`, { fetch: client.fetch }).json<{
            data: Array<AvailableModel & { endpoints?: string[]; tool_calling?: boolean }>
          }>()

          // The catalog also includes embedding, audio, document, and tts
          // models; filter to ones that expose chat completions.
          const tinfoilModels = (response.data || [])
            .filter((m) => Array.isArray(m.endpoints) && m.endpoints.includes('/v1/chat/completions'))
            .map((m) => ({ ...m, supports_tools: m.tool_calling === true }))
            .sort((a, b) => a.id.localeCompare(b.id))

          dispatch({ type: 'FETCH_MODELS_SUCCESS', models: tinfoilModels })
          return
        }
        case 'thunderbolt': {
          const thunderboltModels = [
            { id: 'kimi-k2-instruct', name: 'Kimi K2', supports_tools: true },
            { id: 'deepseek-r1-0528', name: 'DeepSeek R1', supports_tools: true },
            { id: 'mistral-large-3', name: 'Mistral Large 3', supports_tools: true },
            { id: 'llama-v3p1-405b-instruct', name: 'Llama 3.1', supports_tools: true },
          ]
          dispatch({ type: 'FETCH_MODELS_SUCCESS', models: thunderboltModels })
          return
        }
        case 'anthropic': {
          const anthropicModels = [
            {
              id: 'claude-opus-4-1-20250805',
              name: 'Claude Opus 4.1',
              supports_tools: true,
            },
            {
              id: 'claude-opus-4-20250514',
              name: 'Claude Opus 4',
              supports_tools: true,
            },
            {
              id: 'claude-sonnet-4-20250514',
              name: 'Claude Sonnet 4',
              supports_tools: true,
            },
            {
              id: 'claude-3-7-sonnet-20250219',
              name: 'Claude Sonnet 3.7',
              supports_tools: true,
            },
            {
              id: 'claude-3-5-sonnet-20241022',
              name: 'Claude Sonnet 3.5 (New)',
              supports_tools: true,
            },
            {
              id: 'claude-3-5-haiku-20241022',
              name: 'Claude Haiku 3.5',
              supports_tools: true,
            },
            {
              id: 'claude-3-5-sonnet-20240620',
              name: 'Claude Sonnet 3.5 (Old)',
              supports_tools: true,
            },
            {
              id: 'claude-3-haiku-20240307',
              name: 'Claude Haiku 3',
              supports_tools: true,
            },
            {
              id: 'claude-3-opus-20240229',
              name: 'Claude Opus 3',
              supports_tools: true,
            },
          ]
          dispatch({ type: 'FETCH_MODELS_SUCCESS', models: anthropicModels })
          return
        }
      }

      if (endpoint) {
        // For Custom (OpenAI Compatible), try even without API key, otherwise require API key
        if (provider === 'custom' || apiKey) {
          const response = await http.get(endpoint, { headers, fetch }).json<{ data: AvailableModel[] }>()

          let models = (response.data || []).map((m) => {
            const supportsToolsByParams =
              Array.isArray((m as any).supported_parameters) &&
              ((m as any).supported_parameters.includes('tools') ||
                (m as any).supported_parameters.includes('tool_choice'))

            const supportsTools = (m as any).supports_tools === true || supportsToolsByParams

            return { ...m, supports_tools: supportsTools }
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
      // HttpError with a Response object
      else if (typeof error === 'object' && error && 'response' in error) {
        // @ts-expect-error – HttpError shape
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

      const model = allAvailableModels.find((m) => m.id === modelId)

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

  const getProviderDisplay = (provider: string) => {
    switch (provider) {
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
        return provider
    }
  }

  const getModelInitial = (model: Model) => {
    return model.name[0].toUpperCase()
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
    return (model as any)?.supports_tools === true
  })()

  const watchedModel = form.watch('model')

  const canTestConnection = useMemo(() => {
    if (['anthropic', 'tinfoil'].includes(watchedProvider)) {
      return !!watchedModel && watchedApiKey
    }

    return !!watchedModel
  }, [watchedApiKey, watchedModel, watchedProvider])

  return (
    <div className="flex flex-col gap-6 p-4 pb-12 w-full max-w-[760px] mx-auto">
      <PageHeader title="Models">
        <Dialog open={isAddDialogOpen} onOpenChange={handleDialogOpenChange}>
          {canAddModels && (
            <DialogTrigger asChild>
              <Button variant="outline" size="icon" className="rounded-lg">
                <Plus />
              </Button>
            </DialogTrigger>
          )}
          <ResponsiveModalContentComposable className="sm:max-w-[500px] max-h-[90vh] overflow-y-auto">
            <ResponsiveModalHeader>
              <ResponsiveModalTitle>Add Model</ResponsiveModalTitle>
              <ResponsiveModalDescription className="sr-only">Add a new AI model</ResponsiveModalDescription>
            </ResponsiveModalHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} onKeyDown={handleKeyDown} className="grid gap-4 pt-4 pb-2">
                {scopePickerEnabled && (
                  <FormField
                    control={form.control}
                    name="scope"
                    render={({ field }) => (
                      <FormItem>
                        <FormControl>
                          <ScopePicker id="model-scope" value={field.value} onChange={field.onChange} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}
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
                {(watchedModel || selectedModelId === 'custom') && (
                  <>
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
                    <FormField
                      control={form.control}
                      name="toolUsage"
                      render={({ field }) => (
                        <FormItem>
                          <FormControl>
                            <div className="flex items-center gap-3">
                              <Checkbox checked={field.value} onCheckedChange={field.onChange} id="toolUsage" />
                              <FormLabel htmlFor="toolUsage">Enable tool use</FormLabel>
                            </div>
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </>
                )}

                {/* Warning when model lacks tool support */}
                {!supportsToolsSelected && (watchedModel || selectedModelId === 'custom') && (
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
                {canTestConnection && (
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

                <div className="flex justify-end gap-3 pt-2">
                  <Button type="button" variant="ghost" onClick={() => handleDialogOpenChange(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={addModelMutation.isPending}>
                    {addModelMutation.isPending ? 'Adding...' : 'Add Model'}
                  </Button>
                </div>
              </form>
            </Form>
          </ResponsiveModalContentComposable>
        </Dialog>
      </PageHeader>

      <div className="grid gap-4">
        {models.map((model) => {
          const isEnabled = model.enabled === 1
          const isSystemModel = model.isSystem === 1

          return (
            <Card key={model.id} className="border border-border">
              <CardHeader className="py-0">
                <div className="flex items-center justify-between">
                  <div className="flex items-start gap-3 min-w-0 flex-1">
                    <div className="flex items-center justify-center bg-primary text-primary-foreground size-8 rounded-md font-medium flex-shrink-0 mt-1.5">
                      {getModelInitial(model)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <CardTitle className="text-lg font-medium flex flex-row items-center gap-2">
                        {!!model.isConfidential && (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Lock className="size-3.5" />
                              </TooltipTrigger>
                              <TooltipContent side="bottom">
                                <p>Encrypted</p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                        {needsApiKey(model) && (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <AlertTriangle className="size-3.5 text-amber-500" />
                              </TooltipTrigger>
                              <TooltipContent side="bottom">
                                <p>API key not configured</p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                        <ModificationIndicator
                          hasModifications={isModelModified(model) && canAddModels}
                          onReset={() => handleResetModel(model.id)}
                          customMessage="You've customized this model."
                          ariaLabel="Modified model"
                          requireConfirmation={false}
                        >
                          {model.name}
                        </ModificationIndicator>
                      </CardTitle>
                      <p className="text-sm text-muted-foreground">
                        {getProviderDisplay(model.provider)} - {model.model}
                      </p>
                      <ScopeBadge scope={model.scope} show={scopePickerEnabled} className="mt-1" />
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div>
                            <Switch
                              checked={isEnabled}
                              disabled={!canAddModels}
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

                    <ButtonGroup size="icon">
                      <ButtonGroupItem
                        variant="outline"
                        onClick={() => setEditingModel(model)}
                        disabled={isSystemModel || !canAddModels}
                      >
                        <Pen className="h-3 w-3" />
                      </ButtonGroupItem>
                      {canRemoveModels && (
                        <ButtonGroupItem
                          variant="outline"
                          onClick={() => dispatch({ type: 'OPEN_DELETE_CONFIRM', modelId: model.id })}
                          disabled={isSystemModel}
                        >
                          <Trash2 className="h-3 w-3" />
                        </ButtonGroupItem>
                      )}
                    </ButtonGroup>
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
              <Cpu className="size-10 text-muted-foreground mb-4" />
              <h3 className="font-medium text-foreground mb-1">No models configured</h3>
              <p className="text-sm text-muted-foreground mb-4">Get started by adding your first AI model.</p>
              {canAddModels && (
                <Button onClick={() => handleDialogOpenChange(true)} variant="outline">
                  <Plus className="h-4 w-4 mr-2" />
                  Add Model
                </Button>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      {/* Edit Model Modal */}
      <EditModelModal
        model={editingModel}
        onOpenChange={(open) => !open && setEditingModel(null)}
        onSubmit={(values) => editModelMutation.mutate(values)}
        isPending={editModelMutation.isPending}
        // Only the row's author sees the picker in edit mode — matches the
        // SkillForm pattern and the BE handler's owner-only scope flip rule.
        // Defensive null check covers pre-THU-603 rows without a recorded owner.
        showScopePicker={scopePickerEnabled && editingModel?.userId != null && editingModel.userId === currentUserId}
      />

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
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {deleteModelMutation.isPending ? 'Removing...' : 'Remove'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
