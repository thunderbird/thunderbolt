import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Form, FormControl, FormField, FormItem } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DatabaseSingleton } from '@/db/singleton'
import { search } from '@/lib/embeddings'
import type { EmailMessage } from '@/types'
import { zodResolver } from '@hookform/resolvers/zod'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import * as z from 'zod'

const searchFormSchema = z.object({
  searchText: z.string().min(1, 'Please enter search text'),
  limit: z.number().min(1).max(100),
})

type SearchFormValues = z.infer<typeof searchFormSchema>

export default function SearchSection() {
  const db = DatabaseSingleton.instance.db
  const [isSearching, setIsSearching] = useState<boolean>(false)
  const [results, setResults] = useState<any[]>([])
  const [status, setStatus] = useState<string>('')

  const form = useForm<SearchFormValues>({
    resolver: zodResolver(searchFormSchema),
    defaultValues: {
      searchText: '',
      limit: 5,
    },
  })

  const handleSearch = async (values: SearchFormValues) => {
    setIsSearching(true)
    setStatus('Searching...')
    try {
      const searchResults = await search(db, values.searchText, values.limit)
      console.log(searchResults)
      setResults(searchResults)
      setStatus('')
    } catch (error) {
      console.error('Error searching:', error)
      setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`)
      setResults([])
    } finally {
      setIsSearching(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Semantic Search</CardTitle>
        <CardDescription>Search for email messages using semantic similarity</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSearch)} className="space-y-4">
            <div className="flex items-center gap-2">
              <FormField
                control={form.control}
                name="searchText"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormControl>
                      <Input {...field} placeholder="Enter search text" disabled={isSearching} />
                    </FormControl>
                  </FormItem>
                )}
              />
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-600 dark:text-gray-400">Limit:</span>
                <FormField
                  control={form.control}
                  name="limit"
                  render={({ field }) => (
                    <FormItem className="w-16">
                      <FormControl>
                        <Input
                          type="number"
                          {...field}
                          onChange={(e) => field.onChange(Number(e.target.value))}
                          className="p-1 text-sm"
                          min="1"
                          max="100"
                          disabled={isSearching}
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />
              </div>
              <Button type="submit" disabled={isSearching}>
                {isSearching ? 'Searching...' : 'Search'}
              </Button>
            </div>
          </form>
        </Form>

        {status && (
          <div className="mt-2 p-2 bg-gray-100 dark:bg-gray-800 rounded-md">
            <div className="text-sm">{status}</div>
          </div>
        )}

        {results.length > 0 && (
          <div className="mt-4">
            <h3 className="text-lg font-medium mb-2">Results</h3>
            <div className="bg-gray-100 dark:bg-gray-800 rounded-md p-4 overflow-auto max-h-96">
              <Accordion type="single" className="w-full">
                {results.map((result, index) => (
                  <AccordionItem
                    key={index}
                    value={`item-${index}`}
                    className="mb-4 bg-white dark:bg-gray-900 rounded-md shadow-sm"
                  >
                    <AccordionTrigger className="px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-t-md w-full">
                      <div className="grid grid-cols-3 w-full text-left gap-2">
                        <div className="flex items-center">
                          <div className="w-12 h-2 bg-gray-200 dark:bg-gray-600 rounded-full overflow-hidden mr-2">
                            <div
                              className="h-full bg-green-500"
                              style={{ width: `${(1 - (result.distance || 0)) * 100}%` }}
                            />
                          </div>
                          <span className="text-sm font-medium">{(1 - (result.distance || 0)).toFixed(3)}</span>
                        </div>
                        <div className="text-sm font-medium truncate">
                          {result.email_thread?.subject || 'No subject'}
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400 text-right">
                          {result.email_thread?.date
                            ? new Date(result.email_thread.date).toLocaleString()
                            : 'Unknown date'}
                        </div>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent className="border-t border-gray-100 dark:border-gray-800">
                      <Tabs defaultValue="messages" className="w-full">
                        <TabsList className="mb-2 px-4 pt-2">
                          <TabsTrigger value="messages">Messages</TabsTrigger>
                          <TabsTrigger value="embedding">Embedding Text</TabsTrigger>
                        </TabsList>

                        <TabsContent value="messages" className="px-4 pb-4">
                          <div className="space-y-4">
                            {result.email_messages &&
                              result.email_messages.map((message: EmailMessage, msgIndex: number) => (
                                <div key={msgIndex} className="p-3 bg-gray-50 dark:bg-gray-800 rounded-md">
                                  <div className="flex justify-between mb-2">
                                    <div className="font-medium">{message.fromAddress}</div>
                                    <div className="text-xs text-gray-500 dark:text-gray-400">
                                      {new Date(message.sentAt).toUTCString()}
                                    </div>
                                  </div>
                                  <div className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                                    <span className="mr-4">Thread ID: {result.email_thread?.id || 'N/A'}</span>
                                    <span>Message ID: {message.id || message.imapId || 'N/A'}</span>
                                  </div>
                                  <div className="text-sm whitespace-pre-wrap">{message.textBody}</div>
                                </div>
                              ))}
                            {(!result.email_messages || result.email_messages.length === 0) && (
                              <div className="p-3 bg-gray-50 dark:bg-gray-800 rounded-md">
                                <div className="text-sm">No messages available</div>
                              </div>
                            )}
                          </div>
                        </TabsContent>

                        <TabsContent value="embedding" className="px-4 pb-4">
                          <div className="p-3 bg-gray-50 dark:bg-gray-800 rounded-md">
                            <div className="text-xs font-mono whitespace-pre-wrap overflow-auto max-h-60">
                              {result.as_text || 'No embedding text available'}
                            </div>
                          </div>
                        </TabsContent>
                      </Tabs>
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
