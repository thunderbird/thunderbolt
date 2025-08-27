import { CheckCircle2, ChevronDown, RefreshCw, Square } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from './components/ui/button'
import { Skeleton } from './components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './components/ui/tooltip'
import { tasksTable } from './db/tables'
import { useSetting } from './hooks/use-setting'
import { useImap } from './imap/provider'
import { refreshTasks } from './lib/tasks'
import { useSideview } from './sideview/provider'
import { DatabaseSingleton } from '@/db/singleton'

export default function WelcomePage() {
  const { client: imapClient } = useImap()
  const db = DatabaseSingleton.instance.db
  const { setSideview } = useSideview()
  const [_inboxSummary, setInboxSummary] = useState<string | null>(null)
  const [tasksList, setTasksList] = useState<{ item: string; emailMessageId?: string | null }[]>([])
  const [loading, setLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [showAllTasks, setShowAllTasks] = useState(false)

  const [lastGeneratedTasks, setLastGeneratedTasks, { isLoading: isLoadingLastGeneratedTasks }] = useSetting<number>(
    'last_generated_tasks_from_inbox',
  )
  const [preferredName] = useSetting<string>('preferred_name')

  const hours = new Date().getHours()
  const timeOfDay = hours < 12 ? 'Morning' : hours < 18 ? 'Afternoon' : 'Evening'
  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

  const refresh = async (forceRefresh = false) => {
    try {
      setIsRefreshing(true)
      setLoading(true)
      setTasksList([]) // Clear existing tasks while loading

      // Check if we need to regenerate tasks
      const now = new Date().getTime()
      const oneHourInMs = 60 * 60 * 1000

      // If lastGeneratedTasks is more than 1 hour old or doesn't exist, or if forceRefresh is true, regenerate tasks
      if (forceRefresh || !lastGeneratedTasks || now - lastGeneratedTasks > oneHourInMs) {
        console.log('Regenerating tasks')

        if (imapClient.isInitialized) {
          await refreshTasks({ db })
        }

        // Save the timestamp of when we generated the tasks
        // await settingsContext.setSettings({
        //   ...settingsContext.settings,
        //   last_generated_tasks_from_inbox: now.toString(),
        // })

        await setLastGeneratedTasks(now)
      }

      const tasks = await db.select().from(tasksTable).orderBy(tasksTable.id)
      setTasksList(tasks.map((task) => ({ item: task.item, emailMessageId: task.emailMessageId })))
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
    if (!isLoadingLastGeneratedTasks) {
      refresh()
    }
  }, [isLoadingLastGeneratedTasks])

  const displayedTasks = showAllTasks ? tasksList : tasksList.slice(0, 3)

  if (isLoadingLastGeneratedTasks) {
    return <div>Loading...</div>
  }

  return (
    <div className="h-full w-full p-4 sm:p-8 flex flex-col gap-6 bg-gradient-to-br from-background to-secondary/20 overflow-y-auto">
      <div className="max-w-4xl mx-auto w-full">
        <h1 className="text-4xl font-bold tracking-tight mb-2 text-primary">
          {preferredName ? `Good ${timeOfDay}, ${preferredName}` : `Good ${timeOfDay}`}
        </h1>
        <p className="text-muted-foreground text-lg">{date}</p>

        {/* Tasks List Section */}
        <div className="mt-6 bg-card rounded-lg shadow-sm p-6 border border-border hover:border-primary/20 transition-all hover:shadow-md">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-4">
              <div className="bg-primary/10 p-3 rounded-full">
                <CheckCircle2 className="h-6 w-6 text-primary" />
              </div>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger>
                    <h2 className="text-xl font-semibold">Your Tasks</h2>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    <p className="text-sm">Auto-generated from your inbox</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => refresh(true)}
              className="cursor-pointer"
              disabled={isRefreshing}
            >
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
                {displayedTasks.length > 0 ? (
                  <>
                    {displayedTasks.map((task, index) => (
                      <div
                        key={index}
                        className="p-4 bg-secondary/10 hover:bg-secondary/80 rounded-lg flex items-start gap-3 cursor-pointer transition-colors group"
                        onClick={() => task.emailMessageId && setSideview('message', task.emailMessageId)}
                      >
                        <Square className="h-5 w-5 text-primary flex-shrink-0 mt-0.5 group-hover:text-primary/80 transition-colors" />
                        <div className="flex-1">
                          <span className="text-sm font-medium">{task.item}</span>
                        </div>
                      </div>
                    ))}
                    {tasksList.length > 3 && !showAllTasks && (
                      <Button
                        variant="ghost"
                        className="w-full mt-4 flex items-center justify-center gap-2"
                        onClick={() => setShowAllTasks(true)}
                      >
                        Show More <ChevronDown className="h-4 w-4" />
                      </Button>
                    )}
                    {showAllTasks && (
                      <Button
                        variant="ghost"
                        className="w-full mt-4 flex items-center justify-center gap-2"
                        onClick={() => setShowAllTasks(false)}
                      >
                        Show Less <ChevronDown className="h-4 w-4 rotate-180" />
                      </Button>
                    )}
                  </>
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
      </div>
    </div>
  )
}
