import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { eq } from 'drizzle-orm'
import { useState, useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { useParams } from 'react-router'
import { z } from 'zod'

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
import { Card, CardContent } from '@/components/ui/card'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { modelsTable } from '@/db/tables'
import { DatabaseSingleton } from '@/db/singleton'
import type { Model } from '@/types'
import { Trash2 } from 'lucide-react'
import { getModelById } from '@/lib/dal'

const formSchema = z
  .object({
    provider: z.enum(['thunderbolt', 'anthropic', 'openai', 'custom', 'openrouter', 'flower']),
    name: z.string().min(1, { message: 'Name is required.' }),
    model: z.string().min(1, { message: 'Model name is required.' }),
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
      if (data.provider === 'custom') {
        return true // API key is optional for custom provider
      }
      if (data.provider === 'thunderbolt' || data.provider === 'flower') {
        return true // API key not required for thunderbolt or flower
      }
      return data.apiKey !== undefined && data.apiKey.length > 0
    },
    {
      message: 'API Key is required for this provider',
      path: ['apiKey'],
    },
  )

export default function ModelDetailPage() {
  const { modelId } = useParams()
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const db = DatabaseSingleton.instance.db
  const queryClient = useQueryClient()
  const [showSaved, setShowSaved] = useState(false)

  const { data: model, isLoading } = useQuery({
    queryKey: ['models', modelId],
    queryFn: () => getModelById(modelId!),
    enabled: !!modelId,
  })

  const updateModelMutation = useMutation({
    mutationFn: async (model: Partial<Model> & { id: string }) => {
      await db.update(modelsTable).set(model).where(eq(modelsTable.id, model.id))
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['models'] })
      setShowSaved(true)
      setTimeout(() => setShowSaved(false), 2000)
    },
  })

  const deleteModelMutation = useMutation({
    mutationFn: async (id: string) => {
      await db.delete(modelsTable).where(eq(modelsTable.id, id))
      return true
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['models'] })
      setShowDeleteDialog(false)
    },
  })

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      provider: model?.provider || 'thunderbolt',
      name: model?.name || '',
      model: model?.model || '',
      url: model?.url || '',
      apiKey: model?.apiKey || '',
    },
  })

  // Update form values when model changes
  useEffect(() => {
    if (model) {
      form.reset({
        provider: model.provider || 'thunderbolt',
        name: model.name || '',
        model: model.model || '',
        url: model.url || '',
        apiKey: model.apiKey || '',
      })
    }
  }, [model, form])

  const onSubmit = (values: z.infer<typeof formSchema>) => {
    if (modelId) {
      updateModelMutation.mutate({
        id: modelId,
        ...values,
        apiKey: values.apiKey || null,
        url: values.url || null,
      })
    }
  }

  const handleDeleteModel = () => {
    if (modelId) {
      deleteModelMutation.mutate(modelId)
    }
  }

  if (isLoading || !model) {
    return <div className="flex items-center justify-center h-full">Loading...</div>
  }

  return (
    <>
      <Card>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
              {model.isSystem !== 1 && (
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Name</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              {model.isSystem !== 1 && (
                <FormField
                  control={form.control}
                  name="model"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Model</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              {model.isSystem !== 1 && form.watch('provider') === 'custom' && (
                <FormField
                  control={form.control}
                  name="url"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>URL</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              <FormField
                control={form.control}
                name="apiKey"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>API Key</FormLabel>
                    <FormControl>
                      <Input type="password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <Button
                type="submit"
                disabled={updateModelMutation.isPending || !form.formState.isDirty}
                onClick={() => {
                  if (form.formState.isDirty) {
                    setShowSaved(false)
                  }
                }}
              >
                {updateModelMutation.isPending ? 'Saving...' : showSaved ? 'Saved!' : 'Save'}
              </Button>

              {model.isSystem === 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setShowDeleteDialog(true)}
                  className="flex items-center gap-2"
                >
                  <Trash2 className="h-4 w-4" />
                  Delete Model
                </Button>
              )}
            </form>
          </Form>
        </CardContent>
      </Card>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the model "{model.model}". This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteModel} className="bg-destructive hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
