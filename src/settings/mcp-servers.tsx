import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { PageHeader } from '@/components/ui/page-header'
import { useMcpOAuthCallback } from '@/hooks/use-mcp-oauth-callback'
import Loading from '@/loading'
import { Plus, Server } from 'lucide-react'
import { useMcpServersPageState } from './use-mcp-servers-page'
import { McpServerCard } from './mcp-server-card'
import { AddMcpServerDialog } from './add-mcp-server-dialog'

const McpServersPage = () => {
  const { isProcessingOAuth, oauthError } = useMcpOAuthCallback()
  const {
    supportedServers,
    hasUnsupportedServers,
    serverTools,
    selectedTools,
    deleteConfirmOpen,
    setDeleteConfirmOpen,
    copiedUrl,
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
    urlValidation,
    reconnectServer,
    authorizeServer,
  } = useMcpServersPageState()

  if (isProcessingOAuth) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-4">
        <Loading />
        <p className="text-sm text-muted-foreground">Completing MCP server authorization...</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 p-4 w-full max-w-[760px] mx-auto">
      {oauthError && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          OAuth authorization failed: {oauthError}
        </div>
      )}
      <PageHeader title="MCP Servers">
        <AddMcpServerDialog
          isOpen={isAddDialogOpen}
          onOpenChange={(open) => {
            if (open) {
              openAddDialog()
            } else {
              closeAddDialog()
            }
          }}
          formState={formState}
          formDispatch={formDispatch}
          onTestConnection={testConnection}
          onAddServer={handleAddServer}
          onUrlKeyDown={handleUrlKeyDown}
          onArgsInput={handleArgsInput}
          canTestConnection={canTestConnection}
          canAddServer={canAddServer}
          isValid={isValid}
          urlValidation={urlValidation}
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
            onToggle={(id, enabled) => toggleServerMutation.mutate({ id, enabled })}
            onDelete={(id) => deleteServerMutation.mutate(id)}
            onCopyUrl={handleCopyUrl}
            onDeleteConfirmChange={setDeleteConfirmOpen}
            onRetry={reconnectServer}
            onAuthorize={authorizeServer}
            getStatusTooltipText={getStatusTooltipText}
            formatServerTitle={formatServerTitle}
          />
        ))}

        {supportedServers.length === 0 && (
          <Card className="border-dashed border-2 border-muted-foreground/25">
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <Server className="size-10 text-muted-foreground mb-4" />
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

export default McpServersPage
