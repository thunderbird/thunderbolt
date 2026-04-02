import { Bot } from 'lucide-react'
import { Link } from 'react-router'

export const NoAgentsMessage = () => (
  <div className="flex flex-col items-center justify-center text-center gap-4 p-8">
    <Bot className="size-12 text-muted-foreground" />
    <div>
      <h3 className="font-medium text-lg">No agents enabled</h3>
      <p className="text-sm text-muted-foreground mt-1">Enable or install an agent to start chatting.</p>
    </div>
    <Link
      to="/settings/agents"
      className="inline-flex items-center justify-center rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 transition-colors"
    >
      Manage Agents
    </Link>
  </div>
)
