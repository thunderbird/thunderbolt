import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { PageHeader } from '@/components/ui/page-header'
import { Plus } from 'lucide-react'
import { useMcpServersPageState } from './use-mcp-servers-page'
import { McpServerCard } from './mcp-server-card'
import { AddMcpServerDialog } from './add-mcp-server-dialog'

export default function McpServersPage() {
  const {
    supportedServers,
    hasUnsupportedServers,
    serverTools,
    selectedTools,
    deleteConfirmOpen,
    setDeleteConfirmOpen,
    copiedUrl,
    titleRefs,
    formState,
    formDispatch,
    isAddDialogOpen,
    openAddDialog,
    closeAddDialog,
    toggleServerMutation,
    deleteServerMutation,
    testConnection,
    handleAddServer,
    handleUrlKeyDown,
    handleCopyUrl,
    handleArgsInput,
    getConnectionStatus,
    getStatusTooltipText,
    getServerErrorMessage,
    formatServerTitle,
    canTestConnection,
    canAddServer,
    isValid,
    reconnectServer,
  } = useMcpServersPageState()

  return (
    <div className="flex flex-col gap-4 p-4 w-full max-w-[760px] mx-auto">
      <PageHeader title="MCP Servers">
        <AddMcpServerDialog
          isOpen={isAddDialogOpen}
          onOpenChange={(open) => {
            if (open) openAddDialog()
            else closeAddDialog()
          }}
          onClose={closeAddDialog}
          formState={formState}
          formDispatch={formDispatch}
          onTestConnection={testConnection}
          onAddServer={handleAddServer}
          onUrlKeyDown={handleUrlKeyDown}
          onArgsInput={handleArgsInput}
          canTestConnection={canTestConnection}
          canAddServer={canAddServer}
          isValid={isValid}
          trigger={
            <Button variant="outline" size="icon" className="rounded-lg">
              <Plus />
            </Button>
          }
        />
      </PageHeader>

      <div className="grid gap-4">
        {supportedServers.map((server) => (
          <McpServerCard
            key={server.id}
            server={server}
            status={getConnectionStatus(server)}
            tools={serverTools[server.id] || []}
            selectedTools={selectedTools[server.id] || {}}
            errorMessage={getServerErrorMessage(server)}
            copiedUrl={copiedUrl}
            deleteConfirmOpen={deleteConfirmOpen}
            titleRefs={titleRefs}
            onToggle={(id, enabled) => toggleServerMutation.mutate({ id, enabled })}
            onDelete={(id) => deleteServerMutation.mutate(id)}
            onCopyUrl={handleCopyUrl}
            onDeleteConfirmChange={setDeleteConfirmOpen}
            onRetry={reconnectServer}
            getStatusTooltipText={getStatusTooltipText}
            formatServerTitle={formatServerTitle}
          />
        ))}

        {supportedServers.length === 0 && (
          <Card className="border-dashed border-2 border-muted-foreground/25">
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-4">
                <Plus className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="font-medium text-foreground mb-1">No MCP servers configured</h3>
              <p className="text-sm text-muted-foreground mb-4">
                {hasUnsupportedServers
                  ? 'You have servers configured, but they use a transport not supported on this platform (e.g. stdio requires the desktop app).'
                  : 'Get started by adding your first MCP server connection.'}
              </p>
              <Button onClick={openAddDialog} variant="outline">
                <Plus className="h-4 w-4 mr-2" />
                Add Server
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
