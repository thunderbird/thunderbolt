import { useMemo } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { useDatabase } from '@/contexts/database-context'
import { createDrizzleExplorerAdapter } from './drizzle-adapter'
import { DbExplorer } from './db-explorer'

export default function DbExplorerPage() {
  const db = useDatabase()
  const adapter = useMemo(() => createDrizzleExplorerAdapter(db), [db])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 px-4 pt-4">
        <PageHeader title="Database Explorer" />
      </div>
      <div className="min-h-0 flex-1 p-4 pt-2">
        <div className="border-border h-full overflow-hidden rounded-lg border">
          <DbExplorer adapter={adapter} />
        </div>
      </div>
    </div>
  )
}
