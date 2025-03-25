import { useSettings } from '@/settings/provider'
import { createOpenAI } from '@ai-sdk/openai'
import { streamObject } from 'ai'
import { Calendar, CheckCircle2, Mail, MessageSquare, RefreshCw, Square } from 'lucide-react'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import { Button } from './components/ui/button'
import { Skeleton } from './components/ui/skeleton'
import { useImap } from './imap/provider'
import { getFromFromParsedEmail } from './lib/utils'
export default function WelcomePage() {
  const settingsContext = useSettings()
  const { client: imapClient } = useImap()
  const [_inboxSummary, setInboxSummary] = useState<string | null>(null)
  const [toDoList, setToDoList] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [_emails, setEmails] = useState<any[]>([])
  const [isRefreshing, setIsRefreshing] = useState(false)

  const hours = new Date().getHours()
  const timeOfDay = hours < 12 ? 'Morning' : hours < 18 ? 'Afternoon' : 'Evening'
  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

  const fetchInboxData = async () => {
    try {
      if (!imapClient) return

      setIsRefreshing(true)
      setLoading(true)
      setToDoList([]) // Clear existing todos while loading

      // Fetch emails from inbox
      const inboxEmails = await imapClient.fetchInbox('INBOX', undefined, 10)
      setEmails(inboxEmails)

      // Get API key from settings
      const apiKey = settingsContext?.settings?.models?.openai_api_key

      if (!apiKey) {
        setInboxSummary('Please set your OpenAI API key in settings to generate inbox summaries.')
        setLoading(false)
        setIsRefreshing(false)
        return
      }

      const openai = createOpenAI({
        apiKey,
      })

      // Create a prompt for summarizing the inbox
      const emailsContext = inboxEmails
        .map(
          (email) => `Subject: ${email.subject || 'No subject'}\nFrom: ${getFromFromParsedEmail(email) || 'Unknown'}\nSnippet: ${email.snippet || email.clean_text?.substring(0, 300) || 'No content'}`
        )
        .join('\n\n')

      const result = streamObject({
        model: openai('gpt-4o'),
        system: `You are an email assistant that turns emails into a to-do list. Provide up to 3 to-do items based on the emails provided. Only include items that are appear important and actionable. Ignore items that appear to be newsletters, informational, solicitation, or promotional. If you reference a person, use their full name (the user might not know who they are). Assume the user has not read the emails and doesn't know anything about them or the people, places, or ideas mentioned in them. Keep each line under 100 characters.`,
        messages: [
          {
            role: 'user',
            content: `Here are the latest emails in my inbox. Please provide a summary:\n\n${emailsContext}`,
          },
        ],
        output: 'array',
        schema: z.string(),
        //   onChunk({ chunk }) {
        //     if (chunk.type === 'text-delta') {
        //       setLoading(false)
        //       setInboxSummary((prev) => (prev || '') + chunk.textDelta)
        //     }
        //   },
        onError(error) {
          console.error('Error fetching inbox data:', error)
          setInboxSummary('Error loading inbox summary. Please try again later.')
          setLoading(false)
          setIsRefreshing(false)
        },
        onFinish(_response) {},
      })

      // result.consumeStream()
      // console.log(await result.response)

      // for await (const hero of result.elementStream) {
      //   setLoading(false)
      //   setToDoList((prev) => [...prev, hero])
      // }

      for await (const partialObject of result.partialObjectStream) {
        setLoading(false)
        setToDoList((_prev) => partialObject)
      }

      // await result.text
      setLoading(false)
      setIsRefreshing(false)
    } catch (error) {
      console.error('Error fetching inbox data:', error)
      setInboxSummary('Error loading inbox summary. Please try again later.')
      setLoading(false)
      setIsRefreshing(false)
    }
  }

  useEffect(() => {
    fetchInboxData()
  }, [imapClient, settingsContext])

  return (
    <div className="h-full w-full p-8 flex flex-col gap-6 bg-gradient-to-br from-background to-secondary/20">
      <div className="max-w-4xl mx-auto w-full">
        <h1 className="text-4xl font-bold tracking-tight mb-2 text-primary">
          Good {timeOfDay}, <span className="text-primary">Chris</span>
        </h1>
        <p className="text-muted-foreground text-lg">{date}</p>

        {/* To-Do List Section */}
        <div className="mt-6 bg-card rounded-lg shadow-sm p-6 border border-border hover:border-primary/20 transition-all hover:shadow-md">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-4">
              <div className="bg-primary/10 p-3 rounded-full">
                <CheckCircle2 className="h-6 w-6 text-primary" />
              </div>
              <h2 className="text-xl font-semibold">Your Action Items</h2>
            </div>
            <Button variant="ghost" size="icon" onClick={fetchInboxData} className="cursor-pointer" disabled={isRefreshing}>
              <RefreshCw className={`h-5 w-5 ${isRefreshing ? 'animate-spin' : ''}`} />
            </Button>
          </div>
          <div className="space-y-4">
            {loading ? (
              <>
                <div className="flex items-center justify-between">
                  <Skeleton className="h-5 w-[180px]" />
                  <Skeleton className="h-5 w-[80px]" />
                </div>
                <div className="space-y-3 mt-4">
                  <Skeleton className="h-10 w-full rounded-md" />
                  <Skeleton className="h-10 w-full rounded-md" />
                  <Skeleton className="h-10 w-full rounded-md" />
                  <Skeleton className="h-10 w-full rounded-md" />
                  <Skeleton className="h-10 w-full rounded-md" />
                </div>
              </>
            ) : (
              <div className="space-y-1">
                {toDoList.length > 0 ? (
                  toDoList.map((todo, index) => (
                    <div
                      key={index}
                      className="p-4 bg-secondary/10 hover:bg-secondary/80 rounded-lg flex items-start gap-3 cursor-pointer transition-colors group"
                      onClick={() => console.log(`Todo clicked: ${todo}`)}
                    >
                      <Square className="h-5 w-5 text-primary flex-shrink-0 mt-0.5 group-hover:text-primary/80 transition-colors" />
                      <div className="flex-1">
                        <span className="text-sm font-medium">{todo}</span>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="text-center py-6 text-muted-foreground flex flex-col items-center gap-2">
                    <CheckCircle2 className="h-8 w-8 text-primary/40" />
                    <span>No urgent tasks from your inbox. Enjoy your day!</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Inbox Summary Section - Commented out for later
        <div className="mt-6 bg-card rounded-lg shadow-sm p-6 border border-border hover:border-primary/20 transition-all hover:shadow-md">
          <div className="flex items-center gap-4 mb-4">
            <div className="bg-primary/10 p-3 rounded-full">
              <Inbox className="h-6 w-6 text-primary" />
            </div>
            <h2 className="text-xl font-semibold">Inbox Summary</h2>
          </div>
          <div className="space-y-4">
            {loading ? (
              <>
                <div className="flex items-center justify-between">
                  <Skeleton className="h-5 w-[180px]" />
                  <Skeleton className="h-5 w-[80px]" />
                </div>
                <div className="h-2 w-full bg-secondary rounded-full overflow-hidden">
                  <Skeleton className="h-full w-[65%]" />
                </div>
                <div className="grid grid-cols-3 gap-4 mt-4">
                  <div className="bg-secondary/30 p-4 rounded-md">
                    <Skeleton className="h-4 w-[60%] mb-2" />
                    <Skeleton className="h-6 w-[40%]" />
                  </div>
                  <div className="bg-secondary/30 p-4 rounded-md">
                    <Skeleton className="h-4 w-[70%] mb-2" />
                    <Skeleton className="h-6 w-[50%]" />
                  </div>
                  <div className="bg-secondary/30 p-4 rounded-md">
                    <Skeleton className="h-4 w-[80%] mb-2" />
                    <Skeleton className="h-6 w-[45%]" />
                  </div>
                </div>
                <div className="space-y-3 mt-4">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-[92%]" />
                  <Skeleton className="h-4 w-[85%]" />
                </div>
              </>
            ) : (
              <div className="prose prose-sm dark:prose-invert">{inboxSummary || 'No inbox summary available.'}</div>
            )}
          </div>
        </div>
        */}

        <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-card rounded-lg shadow-sm p-6 border border-border hover:border-primary/20 transition-all hover:shadow-md">
            <div className="flex items-center gap-4 mb-4">
              <div className="bg-primary/10 p-3 rounded-full">
                <Mail className="h-6 w-6 text-primary" />
              </div>
              <h2 className="text-xl font-semibold">Recent Emails</h2>
            </div>
            <div className="space-y-3">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-[85%]" />
              <Skeleton className="h-4 w-[70%]" />
            </div>
          </div>

          <div className="bg-card rounded-lg shadow-sm p-6 border border-border hover:border-primary/20 transition-all hover:shadow-md">
            <div className="flex items-center gap-4 mb-4">
              <div className="bg-primary/10 p-3 rounded-full">
                <Calendar className="h-6 w-6 text-primary" />
              </div>
              <h2 className="text-xl font-semibold">Today's Schedule</h2>
            </div>
            <div className="space-y-3">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-[90%]" />
              <Skeleton className="h-4 w-[75%]" />
            </div>
          </div>

          <div className="bg-card rounded-lg shadow-sm p-6 border border-border hover:border-primary/20 transition-all hover:shadow-md">
            <div className="flex items-center gap-4 mb-4">
              <div className="bg-primary/10 p-3 rounded-full">
                <MessageSquare className="h-6 w-6 text-primary" />
              </div>
              <h2 className="text-xl font-semibold">Recent Chats</h2>
            </div>
            <div className="space-y-3">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-[80%]" />
              <Skeleton className="h-4 w-[65%]" />
            </div>
          </div>
        </div>

        <div className="mt-8 bg-card rounded-lg shadow-sm p-6 border border-border">
          <h2 className="text-xl font-semibold mb-4">Quick Actions</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <button className="p-4 bg-primary/5 hover:bg-primary/10 rounded-md flex flex-col items-center justify-center transition-colors">
              <span className="text-sm font-medium">New Chat</span>
            </button>
            <button className="p-4 bg-primary/5 hover:bg-primary/10 rounded-md flex flex-col items-center justify-center transition-colors">
              <span className="text-sm font-medium">Check Email</span>
            </button>
            <button className="p-4 bg-primary/5 hover:bg-primary/10 rounded-md flex flex-col items-center justify-center transition-colors">
              <span className="text-sm font-medium">Settings</span>
            </button>
            <button className="p-4 bg-primary/5 hover:bg-primary/10 rounded-md flex flex-col items-center justify-center transition-colors">
              <span className="text-sm font-medium">Help</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
