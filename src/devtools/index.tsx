import { Sidebar } from '@/components/sidebar'
import { Button } from '@/components/ui/button'
import { ArrowLeft } from 'lucide-react'
import { Link } from 'react-router'
import ImapMailboxesSection from './imap-mailboxes-section'
import ImapSyncSection from './imap-sync-section'

export default function DevToolsPage() {
  return (
    <>
      <Sidebar>
        <div className="flex flex-col gap-4">
          <Button asChild variant="outline">
            <Link to="/">
              <ArrowLeft className="size-4" />
              Home
            </Link>
          </Button>
          <div className="flex flex-col gap-2">
            <Button asChild variant="ghost" className="justify-start">
              <Link to="/settings/accounts">Accounts</Link>
            </Button>
            <Button asChild variant="ghost" className="justify-start">
              <Link to="/settings/models">Models</Link>
            </Button>
            <Button asChild variant="ghost" className="justify-start">
              <Link to="/ui-kit">UI Kit</Link>
            </Button>
            <Button asChild variant="ghost" className="justify-start font-medium text-primary">
              <Link to="/devtools">Dev Tools</Link>
            </Button>
          </div>
        </div>
      </Sidebar>
      <div className="flex flex-col gap-6 p-6 w-full">
        <h1 className="text-3xl font-bold">Dev Tools</h1>
        <p className="text-gray-600 dark:text-gray-400">These tools are only visible during development.</p>

        <div className="grid gap-6">
          <ImapSyncSection />
          <ImapMailboxesSection />
        </div>
      </div>
    </>
  )
}
