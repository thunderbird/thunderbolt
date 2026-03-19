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
import { PageHeader } from '@/components/ui/page-header'
import { ButtonGroup, ButtonGroupItem } from '@/components/ui/button-group'
import { Card, CardContent } from '@/components/ui/card'
import { SearchInput } from '@/components/ui/search-input'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  deleteAutomation,
  getAllPrompts,
  getAllTriggersForPrompt,
  resetAutomationToDefault,
  runAutomation,
} from '@/dal'
import { useDatabase } from '@/contexts'
import { triggersTable } from '@/db/tables'
import { defaultAutomations } from '@/defaults/automations'
import { isAutomationModified } from '@/defaults/utils'
import { useSettings } from '@/hooks/use-settings'
import { trackEvent } from '@/lib/posthog'
import { cn } from '@/lib/utils'
import type { Prompt } from '@/types'
import { useMutation } from '@tanstack/react-query'
import { useQuery } from '@powersync/tanstack-react-query'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { eq } from 'drizzle-orm'
import { Pen, Play, Plus, Search, Trash2 } from 'lucide-react'
import { memo, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import AutomationFormModal from './automation-form-modal'

export default function AutomationsPage() {
  const db = useDatabase()
  const navigate = useNavigate()
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [editingPrompt, setEditingPrompt] = useState<Prompt | null>(null)
  const [deletingPromptId, setDeletingPromptId] = useState<string | null>(null)

  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('')

  const { data: prompts = [], isLoading } = useQuery({
    queryKey: ['prompts', debouncedSearchQuery],
    query: toCompilableQuery(getAllPrompts(db, debouncedSearchQuery)),
    placeholderData: (previousData) => previousData,
  })

  const { isTriggersEnabled } = useSettings({
    is_triggers_enabled: false,
  })

  const deletePromptMutation = useMutation({
    mutationFn: (id: string) => deleteAutomation(db, id),
    onSuccess: () => {
      trackEvent('automation_delete_confirmed', { automation_id: deletingPromptId })
      setDeletingPromptId(null)
    },
  })

  const handleRunPrompt = async (promptId: string) => {
    try {
      const prompt = prompts.find((p) => p.id === promptId)

      const threadId = await runAutomation(db, promptId)

      navigate(`/chats/${threadId}`)
      trackEvent('automation_run', {
        automation_id: promptId,
        model: prompt?.modelId,
        length: prompt?.prompt.length,
      })
    } catch (error) {
      console.error(error)
    }
  }

  const handleEditPrompt = (prompt: Prompt) => {
    setEditingPrompt(prompt)
    trackEvent('automation_modal_edit_open', { automation_id: prompt.id })
  }

  const handleDeletePrompt = (promptId: string) => {
    setDeletingPromptId(promptId)
    trackEvent('automation_delete_clicked', { automation_id: promptId })
  }

  const handleResetPrompt = async (promptId: string) => {
    const defaultAutomation = defaultAutomations.find((d) => d.id === promptId)
    if (defaultAutomation) {
      await resetAutomationToDefault(db, promptId, defaultAutomation)
      // TODO: Add 'automation_reset_to_default' to EventType
      // trackEvent('automation_reset_to_default', { automation_id: promptId })
    }
  }

  return (
    <div className="flex flex-col overflow-hidden">
      <div className="flex-1">
        <div className="flex flex-col gap-6 p-4 w-full max-w-[1200px] mx-auto">
          <PageHeader title="Automations">
            <Button
              variant="outline"
              size="icon"
              className="rounded-lg"
              onClick={() => {
                setIsCreateModalOpen(true)
                trackEvent('automation_modal_create_open')
              }}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </PageHeader>

          {/* Search */}
          <SearchInput
            placeholder="Search automations..."
            debouncedOnChange={(value) => setDebouncedSearchQuery(value)}
            className="rounded-xl"
          />

          {/* Content */}
          <div className="flex-1">
            {isLoading && prompts.length === 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Card key={i}>
                    <CardContent className="p-4">
                      <Skeleton className="h-4 w-full mb-2" />
                      <Skeleton className="h-4 w-3/4 mb-4" />
                      <Skeleton className="h-px w-full mb-4" />
                      <div className="flex justify-end gap-2">
                        <Skeleton className="h-8 w-8" />
                        <Skeleton className="h-8 w-8" />
                        <Skeleton className="h-8 w-8" />
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : prompts.length === 0 ? (
              debouncedSearchQuery ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <Search className="h-12 w-12 text-muted-foreground mb-4" />
                  <h3 className="text-lg font-semibold mb-2">No matching results</h3>
                  <p className="text-muted-foreground mb-4 max-w-md">
                    No automations found matching "{debouncedSearchQuery}". Try adjusting your search terms.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <Plus className="h-12 w-12 text-muted-foreground mb-4" />
                  <h3 className="text-lg font-semibold mb-2">No automations yet</h3>
                  <p className="text-muted-foreground mb-4 max-w-md">
                    Create your first automation to get started. Automations can be triggered by time or other events.
                  </p>
                  <Button onClick={() => setIsCreateModalOpen(true)} className="flex items-center gap-2">
                    <Plus className="h-4 w-4" />
                    Create First Automation
                  </Button>
                </div>
              )
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {prompts.map((prompt) => (
                  <PromptCard
                    key={prompt.id}
                    prompt={prompt}
                    triggersEnabled={isTriggersEnabled.value}
                    onRun={handleRunPrompt}
                    onEdit={handleEditPrompt}
                    onDelete={handleDeletePrompt}
                    onReset={handleResetPrompt}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Create Modal */}
          <AutomationFormModal
            isOpen={isCreateModalOpen}
            onOpenChange={setIsCreateModalOpen}
            onSuccess={() => setIsCreateModalOpen(false)}
          />

          {/* Edit Modal */}
          <AutomationFormModal
            isOpen={!!editingPrompt}
            onOpenChange={(open) => !open && setEditingPrompt(null)}
            prompt={editingPrompt}
            onSuccess={() => {
              setEditingPrompt(null)
            }}
          />

          {/* Delete Confirmation */}
          <AlertDialog open={!!deletingPromptId} onOpenChange={(open) => !open && setDeletingPromptId(null)}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete Automation</AlertDialogTitle>
                <AlertDialogDescription>
                  Are you sure you want to delete this automation? This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={deletePromptMutation.isPending}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    if (deletingPromptId) {
                      deletePromptMutation.mutate(deletingPromptId)
                    }
                  }}
                  disabled={deletePromptMutation.isPending}
                  className="bg-destructive text-white hover:bg-destructive/90"
                >
                  {deletePromptMutation.isPending ? 'Deleting...' : 'Delete'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </div>
  )
}

type PromptCardProps = {
  prompt: Prompt
  triggersEnabled: boolean
  onRun: (promptId: string) => void
  onEdit: (prompt: Prompt) => void
  onDelete: (promptId: string) => void
  onReset: (promptId: string) => void
}

const PromptCard = memo(({ prompt, triggersEnabled, onRun, onEdit, onDelete, onReset }: PromptCardProps) => {
  const db = useDatabase()

  // Query triggers for this prompt via PowerSync for reactive/live updates
  const { data: triggers = [] } = useQuery({
    queryKey: ['triggers', prompt.id],
    query: toCompilableQuery(getAllTriggersForPrompt(db, prompt.id)),
  })

  // For now, use the first trigger's enabled state, or true if no triggers
  const primaryTrigger = triggers[0]
  const [isEnabled, setIsEnabled] = useState(primaryTrigger?.isEnabled === 1 || !primaryTrigger)

  // Update local state when trigger data changes
  useEffect(() => {
    setIsEnabled(primaryTrigger?.isEnabled === 1 || !primaryTrigger)
  }, [primaryTrigger])

  const toggleTriggerMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      if (primaryTrigger) {
        await db
          .update(triggersTable)
          .set({ isEnabled: enabled ? 1 : 0 })
          .where(eq(triggersTable.id, primaryTrigger.id))
      }
    },
  })

  const handleToggleChange = (enabled: boolean) => {
    setIsEnabled(enabled)
    if (primaryTrigger) {
      toggleTriggerMutation.mutate(enabled)
    }
  }

  const truncatedPrompt = prompt.prompt.length > 100 ? prompt.prompt.substring(0, 100) + '...' : prompt.prompt

  return (
    <Card className="h-full flex flex-col pb-0">
      <CardContent className="p-4 flex flex-col flex-1">
        {/* Header with title and toggle */}
        <div className="flex items-center justify-between mb-8">
          {/* Left: Title with reset indicator */}
          <div className="flex-1 min-w-0 mr-6">
            <ModificationIndicator
              as="h3"
              className="text-lg font-semibold text-foreground truncate"
              hasModifications={isAutomationModified(prompt)}
              onReset={() => onReset(prompt.id)}
              customMessage="You've customized this automation."
              ariaLabel="Modified automation"
              requireConfirmation
            >
              {prompt.title || 'Untitled Automation'}
            </ModificationIndicator>
          </div>

          {/* Right: Toggle - only show if triggers are enabled */}
          {triggersEnabled && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <label
                    className="flex items-center gap-2 text-sm cursor-pointer"
                    onClick={!primaryTrigger ? () => onEdit(prompt) : undefined}
                  >
                    <input
                      type="checkbox"
                      checked={primaryTrigger ? isEnabled : false}
                      onChange={primaryTrigger ? (e) => handleToggleChange(e.target.checked) : undefined}
                      className="sr-only"
                      disabled={!primaryTrigger || toggleTriggerMutation.isPending}
                    />
                    <div
                      className={cn(
                        'relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2',
                        primaryTrigger && isEnabled ? 'bg-primary' : 'bg-muted',
                        (!primaryTrigger || toggleTriggerMutation.isPending) && 'opacity-50',
                      )}
                    >
                      <span
                        className={cn(
                          'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out',
                          primaryTrigger && isEnabled ? 'translate-x-4' : 'translate-x-0',
                        )}
                      />
                    </div>
                  </label>
                </TooltipTrigger>
                <TooltipContent>
                  {primaryTrigger ? (isEnabled ? 'Enabled' : 'Disabled') : 'No Trigger Configured'}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>

        {/* Prompt Preview */}
        <div className="flex-1">
          <p className="text-sm text-foreground leading-relaxed">{truncatedPrompt}</p>
        </div>
      </CardContent>

      {/* Action Buttons with full-width divider */}
      <CardContent className="px-4 pb-4">
        <div className="flex justify-end">
          <ButtonGroup size="icon">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <ButtonGroupItem variant="outline" onClick={() => onRun(prompt.id)}>
                    <Play className="h-3 w-3" />
                  </ButtonGroupItem>
                </TooltipTrigger>
                <TooltipContent>Run Automation</TooltipContent>
              </Tooltip>
            </TooltipProvider>

            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <ButtonGroupItem variant="outline" onClick={() => onEdit(prompt)}>
                    <Pen className="h-3 w-3" />
                  </ButtonGroupItem>
                </TooltipTrigger>
                <TooltipContent>Edit Automation</TooltipContent>
              </Tooltip>
            </TooltipProvider>

            {!prompt.defaultHash && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <ButtonGroupItem variant="outline" onClick={() => onDelete(prompt.id)}>
                      <Trash2 className="h-3 w-3" />
                    </ButtonGroupItem>
                  </TooltipTrigger>
                  <TooltipContent>Delete Automation</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </ButtonGroup>
        </div>
      </CardContent>
    </Card>
  )
})

PromptCard.displayName = 'PromptCard'
