/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Check, LockKeyhole, X } from 'lucide-react'
import type { ComponentProps, KeyboardEvent, ReactNode } from 'react'

import { IrohPairingPanel } from '@/components/settings/iroh-pairing-panel'
import { Button } from '@/components/ui/button'
import { FormFooter } from '@/components/ui/form-footer'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ResponsiveModalCancel } from '@/components/ui/responsive-modal'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { StatusCard } from '@/components/ui/status-card'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { UseAddServerFormResult } from '@/hooks/use-add-server-form'
import type { TestConnectionResult } from '@/lib/mcp-auth/auth-decision'
import type { MCPTransportType } from '@/lib/mcp-transport'
import type { validateMcpServerUrl } from '@/lib/mcp-url-validation'

/** Add-form mode: a single guided server form, or a raw JSON config paste. */
export type AddServerMode = 'simple' | 'advanced'

type StatusTone = 'success' | 'warning' | 'destructive'

/**
 * Tone → icon color. The box itself stays a neutral card — a wash of
 * green/red reads as shouty, so the tone is carried by the icon alone.
 * Tailwind v4's JIT scanner only sees static class names, so the tone must
 * NEVER be interpolated into a class string — look the literals up here.
 */
const toneIconClasses: Record<StatusTone, string> = {
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
}

/** A status box (toned icon + bold title row) used by the form's result panels. */
const ResultStatusCard = ({
  tone,
  icon,
  title,
  children,
}: {
  tone: StatusTone
  icon: ReactNode
  title: string
  children?: ReactNode
}) => (
  <StatusCard icon={<span className={toneIconClasses[tone]}>{icon}</span>} title={title}>
    {children}
  </StatusCard>
)

/**
 * The non-success test-result panels are pure data — each maps a result `kind`
 * to its tone, icon, title, and body copy. `success` is rendered separately
 * because it carries a tools list as the panel's children.
 */
const testResultPanels: Record<
  Exclude<TestConnectionResult['kind'], 'success'>,
  { tone: StatusTone; icon: ReactNode; title: string; body: string }
> = {
  'needs-oauth': {
    tone: 'warning',
    icon: <LockKeyhole className="h-4 w-4" />,
    title: 'Authorization required',
    body: 'This server uses OAuth. Add it and authorize to connect.',
  },
  'needs-token': {
    tone: 'warning',
    icon: <LockKeyhole className="h-4 w-4" />,
    title: 'Access token required',
    body: 'This server needs a personal access token or API key. Paste it in the Credential field above, then test again.',
  },
  'token-rejected': {
    tone: 'destructive',
    icon: <X className="h-4 w-4" />,
    title: 'Token rejected',
    body: 'The server rejected the credential. Check your bearer token or API key.',
  },
  error: {
    tone: 'destructive',
    icon: <X className="h-4 w-4" />,
    title: 'Connection failed',
    body: 'Could not connect to the MCP server. Please check the URL and try again.',
  },
}

/**
 * The Add/Edit MCP server form, hosted inside the Connections detail aside
 * (the `DetailPanel` shell provides the title + close). All state and handlers
 * live in the page (`ConnectionsPage`) — this component is the ported dialog
 * body from the old MCP Servers page, unchanged in behavior.
 */
export const McpServerForm = ({
  form,
  mode,
  onModeChange,
  jsonText,
  onJsonTextChange,
  errorPanel,
  appNodeId,
  urlValidation,
  isUrlReady,
  isSaveReady,
  editProbeWaived,
  isAddAuthorizePending,
  isSavePending,
  isImportPending,
  onCancel,
  onAddServer,
  onUpdateServer,
  onImportConfig,
  onAddAndAuthorize,
  onUrlKeyDown,
}: {
  form: UseAddServerFormResult
  mode: AddServerMode
  onModeChange: (mode: AddServerMode) => void
  jsonText: string
  onJsonTextChange: (value: string) => void
  /** The single form-scoped error (import / save / authorization), pre-labeled. */
  errorPanel: { title: string; body: string } | null
  appNodeId: ComponentProps<typeof IrohPairingPanel>['appNodeId']
  urlValidation: ReturnType<typeof validateMcpServerUrl> | null
  isUrlReady: boolean
  isSaveReady: boolean
  /** True when the edit can save without a fresh successful probe. */
  editProbeWaived: boolean
  isAddAuthorizePending: boolean
  isSavePending: boolean
  isImportPending: boolean
  onCancel: () => void
  onAddServer: () => void
  onUpdateServer: () => void
  onImportConfig: () => void
  onAddAndAuthorize: () => void
  onUrlKeyDown: (e: KeyboardEvent) => void
}) => {
  const {
    name: newServerName,
    url: newServerUrl,
    transport: newServerTransport,
    isIroh,
    token: newServerToken,
    testResult,
    isTestingConnection,
    serverCapabilities,
    testConnection,
    handleUrlBlur,
  } = form

  return (
    <div className="flex flex-1 flex-col">
      {/* Advanced (JSON) is bulk-import only — irrelevant when editing a single server. */}
      {!form.editingServerId && (
        <ToggleGroup
          type="single"
          variant="outline"
          value={mode}
          onValueChange={(value) => {
            if (value !== 'simple' && value !== 'advanced') {
              return
            }
            onModeChange(value)
          }}
          className="w-full flex-shrink-0 rounded-lg"
        >
          {/* rounded-lg to match the Input fields below (same treatment
              as the preferences ThemeToggleGroup). */}
          <ToggleGroupItem
            value="simple"
            className="first:rounded-l-lg last:rounded-r-lg data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=off]:bg-transparent data-[state=off]:text-muted-foreground dark:data-[state=on]:bg-accent"
          >
            Simple
          </ToggleGroupItem>
          <ToggleGroupItem
            value="advanced"
            className="first:rounded-l-lg last:rounded-r-lg data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=off]:bg-transparent data-[state=off]:text-muted-foreground dark:data-[state=on]:bg-accent"
          >
            Advanced (JSON)
          </ToggleGroupItem>
        </ToggleGroup>
      )}

      <div className="flex-1">
        {mode === 'simple' ? (
          <div className="grid grid-cols-1 gap-4 pt-4 pb-2">
            <div className="grid grid-cols-1 gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                placeholder="Server name (used to prefix tools)"
                value={newServerName}
                onChange={(e) => form.changeName(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-1 gap-2">
              <Label htmlFor="url">Server URL</Label>
              <Input
                id="url"
                placeholder="http://localhost:8000/mcp/"
                value={newServerUrl}
                onChange={(e) => form.changeUrl(e.target.value)}
                onBlur={handleUrlBlur}
                onKeyDown={onUrlKeyDown}
                aria-invalid={urlValidation?.ok === false}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
              {urlValidation?.ok === false && (
                <p className="text-[length:var(--font-size-xs)] text-destructive">{urlValidation.reason}</p>
              )}
              <p className="text-[length:var(--font-size-xs)] text-muted-foreground">
                A URL, or paste an iroh ticket from your bridge for a peer-to-peer connection (a bare NodeId works only
                if the peer is discoverable).
              </p>
            </div>

            {/* iroh dials a peer bridge by NodeId/ticket — no transport
                Select, credential, or probe (the link is encrypted and
                allowlist-gated, verified on first use). */}
            {isIroh ? (
              <IrohPairingPanel appNodeId={appNodeId} />
            ) : (
              <>
                <div className="grid grid-cols-1 gap-2">
                  <Label htmlFor="transport">Transport</Label>
                  <Select
                    value={newServerTransport}
                    onValueChange={(value) => form.changeTransport(value as MCPTransportType)}
                  >
                    <SelectTrigger id="transport" className="w-full rounded-lg">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="http">HTTP</SelectItem>
                      <SelectItem value="sse">SSE</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid grid-cols-1 gap-2">
                  <Label htmlFor="token">Credential (optional)</Label>
                  <Input
                    id="token"
                    type="password"
                    placeholder="Bearer token or API key"
                    value={newServerToken}
                    onChange={(e) => form.changeToken(e.target.value)}
                  />
                </div>

                {isUrlReady && (
                  <Button onClick={testConnection} disabled={isTestingConnection} variant="outline" className="w-full">
                    {isTestingConnection ? 'Testing connection…' : 'Test connection'}
                  </Button>
                )}

                {testResult.kind === 'success' && (
                  <ResultStatusCard tone="success" icon={<Check className="h-4 w-4" />} title="Connection successful!">
                    {serverCapabilities.length > 0 && (
                      <div className="mt-3">
                        <p className="text-sm font-medium text-foreground">Available tools:</p>
                        <ul className="text-sm text-muted-foreground mt-1 space-y-1 max-h-40 overflow-y-auto">
                          {serverCapabilities.map((capability, index) => (
                            <li key={index} className="flex items-center gap-2">
                              <div className="w-1 h-1 bg-muted-foreground rounded-full" />
                              {capability}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </ResultStatusCard>
                )}

                {testResult.kind !== 'success' &&
                  testResult.kind !== 'idle' &&
                  (() => {
                    const panel = testResultPanels[testResult.kind]
                    return (
                      <ResultStatusCard tone={panel.tone} icon={panel.icon} title={panel.title}>
                        <p className="text-sm mt-1 text-muted-foreground">{panel.body}</p>
                      </ResultStatusCard>
                    )
                  })()}
              </>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 pt-4 pb-2">
            <div className="grid grid-cols-1 gap-2">
              <Label htmlFor="json-config">Servers JSON</Label>
              <Textarea
                id="json-config"
                className="font-mono text-[length:var(--font-size-xs)] min-h-48 max-h-[40vh] overflow-y-auto resize-none"
                placeholder={
                  '{\n  "mcpServers": {\n    "example": {\n      "url": "https://example.com/mcp"\n    }\n  }\n}'
                }
                value={jsonText}
                onChange={(e) => onJsonTextChange(e.target.value)}
              />
              <p className="text-[length:var(--font-size-xs)] text-muted-foreground">
                Paste an <code>mcpServers</code> config. Only remote (http/sse) servers are supported; non-Bearer auth
                headers are ignored.
              </p>
            </div>
          </div>
        )}

        {errorPanel && (
          <div className="mb-2">
            <ResultStatusCard tone="destructive" icon={<X className="h-4 w-4" />} title={errorPanel.title}>
              <p className="text-sm text-muted-foreground mt-1 whitespace-pre-line">{errorPanel.body}</p>
            </ResultStatusCard>
          </div>
        )}
      </div>

      <FormFooter>
        <ResponsiveModalCancel onClick={onCancel}>Cancel</ResponsiveModalCancel>
        {form.editingServerId ? (
          <Button
            onClick={onUpdateServer}
            // A fresh successful probe is required only when the edit touches
            // the connection and no waiver applies (see `editProbeWaived`):
            // iroh has no probe, and metadata-only / bearer-clear / empty-token
            // OAuth edits keep the existing credential valid.
            disabled={!isSaveReady || (!editProbeWaived && testResult.kind !== 'success') || isSavePending}
          >
            {isSavePending ? 'Saving…' : 'Save Changes'}
          </Button>
        ) : mode === 'advanced' ? (
          <Button onClick={onImportConfig} disabled={!jsonText.trim() || isImportPending}>
            {isImportPending ? 'Importing…' : 'Import Servers'}
          </Button>
        ) : !isIroh && testResult.kind === 'needs-oauth' ? (
          <Button onClick={onAddAndAuthorize} disabled={!isUrlReady || isAddAuthorizePending}>
            <LockKeyhole className="h-3.5 w-3.5 mr-1.5" />
            Add &amp; Authorize
          </Button>
        ) : (
          <Button
            onClick={onAddServer}
            disabled={!isSaveReady || (!isIroh && testResult.kind !== 'success') || isSavePending}
          >
            {isSavePending ? 'Adding…' : 'Add server'}
          </Button>
        )}
      </FormFooter>
    </div>
  )
}
