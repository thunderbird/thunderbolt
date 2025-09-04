import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { useNavigate } from 'react-router'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { modelsTable } from '@/db/tables'
import { DatabaseSingleton } from '@/db/singleton'
import type { Model } from '@/types'

const formSchema = z
  .object({
    provider: z.enum(['thunderbolt', 'openai', 'custom', 'openrouter', 'flower']),
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
        return true // API key optional for thunderbolt and flower
      }
      return data.apiKey !== undefined && data.apiKey.length > 0
    },
    {
      message: 'API Key is required for this provider',
      path: ['apiKey'],
    },
  )

export default function NewModelPage() {
  const navigate = useNavigate()
  const db = DatabaseSingleton.instance.db
  const queryClient = useQueryClient()

  const createModelMutation = useMutation({
    mutationFn: async (model: Omit<Model, 'id'>) => {
      const id = uuidv7()
      await db.insert(modelsTable).values({
        id,
        ...model,
      })
      return id
    },
    onSuccess: (id) => {
      queryClient.invalidateQueries({ queryKey: ['models'] })
      navigate(`/settings/models/${id}`)
    },
  })

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      provider: 'thunderbolt',
      name: '',
      model: '',
      url: '',
      apiKey: '',
    },
  })

  const onSubmit = (values: z.infer<typeof formSchema>) => {
    createModelMutation.mutate({
      ...values,
      apiKey: values.apiKey || null,
      url: values.url || null,
      isSystem: 0,
      enabled: 1,
      toolUsage: 1,
      isConfidential: 0,
      startWithReasoning: 0,
      contextWindow: null,
    })
  }

  return (
    <Card>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
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

            {form.watch('provider') === 'custom' && (
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

            <Button type="submit" disabled={createModelMutation.isPending}>
              {createModelMutation.isPending ? 'Adding...' : 'Add Model'}
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  )
}
