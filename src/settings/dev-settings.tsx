import { settingsTable } from '@/db/tables'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { eq } from 'drizzle-orm'
import React from 'react'

import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { SectionCard } from '@/components/ui/section-card'

import { DatabaseSingleton } from '@/db/singleton'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

const cloudFormSchema = z.object({
  cloudUrl: z.string(),
})

export default function DevSettingsPage() {
  const queryClient = useQueryClient()

  // Get any existing settings from the database
  const { data: settings } = useQuery({
    queryKey: ['dev-settings'],
    queryFn: async () => {
      const db = DatabaseSingleton.instance.db
      const cloudUrlData = await db.select().from(settingsTable).where(eq(settingsTable.key, 'cloud_url'))

      return {
        cloudUrl: cloudUrlData[0]?.value || '',
      }
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
      cloudForm.reset({
        cloudUrl: settings.cloudUrl as string,
      })
    }
  }, [settings, cloudForm])

  const cloudMutation = useMutation({
    mutationFn: async (values: z.infer<typeof cloudFormSchema>) => {
      const db = DatabaseSingleton.instance.db
      await db
        .insert(settingsTable)
        .values({
          key: 'cloud_url',
          value: values.cloudUrl,
        })
        .onConflictDoUpdate({
          target: settingsTable.key,
          set: { value: values.cloudUrl },
        })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dev-settings'] })
    },
  })

  const onCloudSubmit = (values: z.infer<typeof cloudFormSchema>) => {
    cloudMutation.mutate(values)
  }

  const clearDatabaseMutation = useMutation({
    mutationFn: async () => {
      const db = DatabaseSingleton.instance.db
      // Clear all tables
      await db.delete(settingsTable)
    },
    onSuccess: () => {
      queryClient.invalidateQueries()
    },
  })

  const clearDatabase = () => {
    if (confirm('Are you sure you want to clear the database? This action cannot be undone.')) {
      clearDatabaseMutation.mutate()
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium">Development Settings</h3>
        <p className="text-sm text-muted-foreground">Configure development-specific settings.</p>
      </div>

      <SectionCard title="Cloud Configuration">
        <p className="text-sm text-muted-foreground mb-4">Configure the cloud URL for syncing data.</p>
        <Form {...cloudForm}>
          <form onSubmit={cloudForm.handleSubmit(onCloudSubmit)} className="space-y-4">
            <FormField
              control={cloudForm.control}
              name="cloudUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Cloud URL</FormLabel>
                  <FormControl>
                    <Input placeholder="https://your-cloud-url.com" {...field} />
                  </FormControl>
                  <FormDescription>The URL of your cloud instance for syncing data.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <button
              type="submit"
              className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-4 py-2"
              disabled={cloudMutation.isPending}
            >
              {cloudMutation.isPending ? 'Saving...' : 'Save Cloud Settings'}
            </button>
          </form>
        </Form>
      </SectionCard>

      <SectionCard title="Database Management">
        <p className="text-sm text-muted-foreground mb-4">Manage your local database.</p>
        <div className="space-y-4">
          <button
            onClick={clearDatabase}
            className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-10 px-4 py-2 text-destructive border-destructive hover:bg-destructive hover:text-destructive-foreground"
            disabled={clearDatabaseMutation.isPending}
          >
            {clearDatabaseMutation.isPending ? 'Clearing...' : 'Clear Database'}
          </button>
        </div>
      </SectionCard>
    </div>
  )
}
