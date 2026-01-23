import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card'
import { Form, FormControl, FormField, FormItem, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { PromptInput } from '@/components/ui/prompt-input'
import {
  ResponsiveModal,
  ResponsiveModalContentComposable,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from '@/components/ui/responsive-modal'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DatabaseSingleton } from '@/db/singleton'
import { triggersTable } from '@/db/tables'
import {
  createAutomation,
  createTrigger,
  deleteTriggersForPrompt,
  getAllTriggersForPrompt,
  getAvailableModels,
  getSelectedModel,
  updateAutomation,
} from '@/dal'
import { useSettings } from '@/hooks/use-settings'
import { trackEvent } from '@/lib/posthog'
import { generateTitle } from '@/lib/title-generator'
import type { Model, Prompt } from '@/types'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { eq } from 'drizzle-orm'
import { useCallback, useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'

const formSchema = z.object({
  title: z.string().optional(),
  prompt: z.string().min(1, { message: 'Prompt is required.' }),
  modelId: z.string().min(1, { message: 'Model is required.' }),
  triggerType: z.enum(['manual', 'time']),
  triggerTime: z.string().optional(),
})

type FormData = z.infer<typeof formSchema>

interface AutomationFormModalProps {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  prompt?: Prompt | null
  onSuccess?: () => void
}

export default function AutomationFormModal({
  isOpen,
  onOpenChange,
  prompt = null,
  onSuccess,
}: AutomationFormModalProps) {
  const db = DatabaseSingleton.instance.db
  const queryClient = useQueryClient()

  const { data: models = [] } = useQuery<Model[]>({
    queryKey: ['models', 'availableModels'],
    queryFn: getAvailableModels,
  })

  const { data: selectedModel } = useQuery<Model>({
    queryKey: ['models', 'selectedModel'],
    queryFn: getSelectedModel,
  })

  const { isTriggersEnabled } = useSettings({
    is_triggers_enabled: false,
  })

  const [promptText, setPromptText] = useState('')
  const [modelId, setModelId] = useState<string | null>(null)
  const [titleText, setTitleText] = useState('')

  // Update form values when our state changes
  const handlePromptChange = (value: string) => {
    setPromptText(value)
    form.setValue('prompt', value)
  }

  const handleTitleChange = (value: string) => {
    setTitleText(value)
    form.setValue('title', value)
  }

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      title: '',
      prompt: '',
      modelId: selectedModel?.id || '',
      triggerType: 'manual',
      triggerTime: '08:00',
    },
  })

  const handleModelChange = useCallback(
    (value: string | null) => {
      setModelId(value)
      form.setValue('modelId', value || '')
    },
    [form],
  )

  // Reset form and state when prompt changes or modal opens/closes
  useEffect(() => {
    if (isOpen) {
      if (prompt) {
        // Load existing trigger data if editing
        const loadTriggerData = async () => {
          const existingTriggers = await getAllTriggersForPrompt(prompt.id)
          const trigger = existingTriggers[0] // Assuming one trigger per prompt

          const promptText = prompt.prompt
          const titleText = prompt.title || ''
          const modelId = prompt.modelId || selectedModel?.id || ''

          setPromptText(promptText)
          setTitleText(titleText)
          setModelId(modelId)

          form.reset({
            title: titleText,
            prompt: promptText,
            modelId: modelId,
            triggerType: trigger?.triggerType || 'manual',
            triggerTime: trigger?.triggerTime || '08:00',
          })
        }
        loadTriggerData()
      } else {
        const defaultModelId = selectedModel?.id || ''

        setPromptText('')
        setTitleText('')
        setModelId(defaultModelId)

        form.reset({
          title: '',
          prompt: '',
          modelId: defaultModelId,
          triggerType: 'manual',
          triggerTime: '08:00',
        })
      }
    }
  }, [isOpen, prompt, form, selectedModel, db])

  const createPromptMutation = useMutation({
    mutationFn: async (values: FormData) => {
      const promptId = uuidv7()
      const generatedTitle = generateTitle(values.prompt, { words: 4 })

      // Create the prompt with model and generated title
      await createAutomation({
        id: promptId,
        title: generatedTitle,
        prompt: values.prompt,
        modelId: values.modelId,
        defaultHash: null, // User-created, not based on a default
      })

      // Create trigger if specified and not manual
      if (values.triggerType === 'time' && values.triggerTime) {
        await createTrigger({
          id: uuidv7(),
          triggerType: values.triggerType,
          triggerTime: values.triggerTime,
          promptId: promptId,
          isEnabled: 1,
        })
      }
    },
    onSuccess: (_, values) => {
      trackEvent('automation_create', {
        model: values.modelId,
        triggerType: values.triggerType,
      })
      queryClient.invalidateQueries({ queryKey: ['prompts'] })
      onOpenChange(false)
      onSuccess?.()
    },
  })

  const updatePromptMutation = useMutation({
    mutationFn: async (values: FormData) => {
      if (!prompt) return

      // Update the prompt with model and title
      await updateAutomation(prompt.id, {
        title: values.title || null,
        prompt: values.prompt,
        modelId: values.modelId,
      })

      // Handle trigger updates when editing
      const existingTriggers = await getAllTriggersForPrompt(prompt.id)
      const hasNewTriggerData = values.triggerType === 'time' && values.triggerTime

      if (hasNewTriggerData) {
        // User wants to add/update a trigger
        if (existingTriggers.length > 0) {
          // Update existing trigger
          await db
            .update(triggersTable)
            .set({
              triggerType: 'time',
              triggerTime: values.triggerTime!,
              isEnabled: 1,
            })
            .where(eq(triggersTable.promptId, prompt.id))
        } else {
          // Create new trigger
          await createTrigger({
            id: uuidv7(),
            triggerType: 'time',
            triggerTime: values.triggerTime!,
            promptId: prompt.id,
            isEnabled: 1,
          })
        }
      } else {
        // User selected manual or removed trigger data, delete any existing triggers
        if (existingTriggers.length > 0) {
          await deleteTriggersForPrompt(prompt.id)
        }
      }
    },
    onSuccess: (_, values) => {
      trackEvent('automation_update', {
        automation_id: prompt?.id,
        old_model: prompt?.modelId,
        new_model: values.modelId,
      })
      queryClient.invalidateQueries({ queryKey: ['prompts'] })
      queryClient.invalidateQueries({ queryKey: ['triggers'] })
      onOpenChange(false)
      onSuccess?.()
    },
  })

  const onSubmit = (values: FormData) => {
    // Validate prompt text
    if (!promptText.trim()) {
      return
    }

    // Model is always required for any automation
    if (!modelId) {
      return
    }

    // Validate trigger-specific fields
    if (values.triggerType === 'time') {
      if (!values.triggerTime) {
        form.setError('triggerTime', { message: 'Trigger time is required when setting up a time trigger' })
        return
      }
    }

    // Create updated values with our state
    const updatedValues: FormData = {
      ...values,
      prompt: promptText,
      modelId: modelId || '',
    }

    if (prompt) {
      updatePromptMutation.mutate(updatedValues)
    } else {
      createPromptMutation.mutate(updatedValues)
    }
  }

  const selectedTriggerType = form.watch('triggerType')
  const isLoading = createPromptMutation.isPending || updatePromptMutation.isPending

  return (
    <ResponsiveModal open={isOpen} onOpenChange={onOpenChange}>
      <ResponsiveModalContentComposable className="sm:max-w-[600px] p-0">
        <ResponsiveModalHeader className="px-6 pt-6">
          <ResponsiveModalTitle>{prompt ? 'Edit Automation' : 'Create Automation'}</ResponsiveModalTitle>
        </ResponsiveModalHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <Card className="border-0 shadow-none">
              {/* Main Content - Title Input (only when editing) */}
              {prompt && (
                <CardHeader className="px-6 pb-2">
                  <FormField
                    control={form.control}
                    name="title"
                    render={() => (
                      <FormItem>
                        <FormControl>
                          <Input
                            placeholder="Automation title"
                            value={titleText}
                            onChange={(e) => handleTitleChange(e.target.value)}
                            className="text-lg font-medium"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </CardHeader>
              )}

              {/* Main Content - Prompt Input */}
              <CardHeader className="px-6 pb-0 pt-2">
                <PromptInput
                  chatThread={null}
                  value={promptText}
                  onChange={handlePromptChange}
                  placeholder="Enter your prompt here..."
                  models={models}
                  selectedModelId={modelId ?? undefined}
                  onModelChange={handleModelChange}
                  showSubmitButton={false}
                  noForm
                  className="flex flex-col gap-2 bg-secondary p-4 rounded-md w-full"
                />
              </CardHeader>

              {/* Trigger Section - Direct Below Prompt */}
              {isTriggersEnabled.value && (
                <CardContent className="px-6 pb-4">
                  <div className="space-y-4">
                    {/* Inline trigger configuration */}

                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm">Runs when</span>
                      <FormField
                        control={form.control}
                        name="triggerType"
                        render={({ field }) => (
                          <FormItem>
                            <FormControl>
                              <Select value={field.value} onValueChange={field.onChange}>
                                <SelectTrigger className="w-fit">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="manual">I click run</SelectItem>
                                  <SelectItem value="time">time</SelectItem>
                                </SelectContent>
                              </Select>
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      {/* Show time input when time trigger is selected */}
                      {selectedTriggerType === 'time' && (
                        <>
                          <span className="text-sm">is</span>
                          <FormField
                            control={form.control}
                            name="triggerTime"
                            render={({ field }) => (
                              <FormItem>
                                <FormControl>
                                  <Input type="time" className="w-auto" {...field} />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        </>
                      )}
                    </div>
                  </div>
                </CardContent>
              )}

              {/* Footer with Submit Button */}
              <CardFooter className="px-6 pt-4">
                <Button type="submit" className="w-full" disabled={isLoading}>
                  {isLoading ? 'Saving...' : prompt ? 'Update Automation' : 'Create Automation'}
                </Button>
              </CardFooter>
            </Card>
          </form>
        </Form>
      </ResponsiveModalContentComposable>
    </ResponsiveModal>
  )
}
