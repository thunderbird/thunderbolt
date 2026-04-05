import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { DataTable } from './data-table'
import { ObjectList } from './object-list'
import { SqlDefinition } from './sql-definition'
import { SqlEditor } from './sql-editor'
import type { SqliteExplorerAdapter } from './types'
import { useDbExplorerState } from './use-db-explorer-state'

type DbExplorerProps = {
  adapter: SqliteExplorerAdapter
}

export const DbExplorer = ({ adapter }: DbExplorerProps) => {
  const { state, selectObject, runQuery, fetchPage, setPageSize, setCustomSql } = useDbExplorerState(adapter)

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ResizablePanelGroup direction="horizontal">
        {/* Sidebar: object list */}
        <ResizablePanel defaultSize={22} minSize={15} maxSize={40}>
          <div className="border-r flex h-full flex-col overflow-hidden">
            <div className="border-b px-3 py-2 text-xs font-semibold">Database Objects</div>
            <ObjectList
              adapter={adapter}
              objects={state.objects}
              selectedObject={state.selectedObject}
              onSelect={selectObject}
            />
          </div>
        </ResizablePanel>

        <ResizableHandle />

        {/* Main content */}
        <ResizablePanel defaultSize={78}>
          {state.viewMode === 'definition' ? (
            <SqlDefinition value={state.sqlDefinition ?? 'No SQL definition available'} />
          ) : (
            <div className="flex h-full flex-col overflow-hidden">
              <div className="border-b p-3">
                <SqlEditor
                  value={state.customSql}
                  onChange={setCustomSql}
                  onRun={runQuery}
                  isLoading={state.isLoading}
                  error={state.error}
                  queryTimeMs={state.queryTimeMs}
                />
              </div>
              <DataTable
                result={state.queryResult}
                isLoading={state.isLoading}
                page={state.page}
                pageSize={state.pageSize}
                totalRows={state.totalRows}
                onPageChange={fetchPage}
                onPageSizeChange={setPageSize}
              />
            </div>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}
