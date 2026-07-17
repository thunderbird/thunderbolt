/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { arch } from '@tauri-apps/plugin-os'
import { AlertTriangle, Check, ChevronRight, Download, ExternalLink, Loader2, Terminal, X } from 'lucide-react'
import { useState, useTransition } from 'react'
import { CopyCommandRow } from '@/components/settings/copy-command-row'
import { Button, mutedIconButtonClass } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  type CliInstallArchitecture,
  type CliInstallPlatform,
  type CliInstallResult,
  canInstallThunderboltCli,
  describeCliInstallError,
  installThunderboltCli,
} from '@/lib/cli-install'
import { getPlatform, isTauri } from '@/lib/platform'
import { cn } from '@/lib/utils'

/** Shell one-liner to build the CLI from source when no prebuilt binary applies. */
const manualBuildCommand = 'cd cli && bun install && bun run build && ./install.sh'
const cliInstallGuideUrl = 'https://github.com/thunderbird/thunderbolt/blob/main/cli/README.md#install'

/** Secondary line shared by the list row and the detail-header subtitle, the
 *  same pairing rule the agent rows follow via `agentProvenanceLine`. */
const cliProvenanceLine = 'Your agent · runs in your terminal'

type InstallState =
  | { status: 'idle' }
  | { status: 'success'; result: CliInstallResult }
  | { status: 'error'; message: string; showManualBuild: boolean }

type ThunderboltCliRowProps = {
  /** Whether the CLI detail panel is open — brightens the row like the agent rows. */
  selected?: boolean
  /** Opens the CLI detail panel. */
  onOpen: () => void
  /** Test seam for the runtime platform; production reads `getPlatform()`. */
  platform?: CliInstallPlatform
  /** Test seam for the runtime CPU architecture; production reads Tauri's OS plugin. */
  architecture?: CliInstallArchitecture
  /** Test seam for the Tauri check; production reads `isTauri()`. */
  tauri?: boolean
}

/**
 * List row for the standalone `thunderbolt` CLI agent — the exact anatomy of
 * an agent row (icon box, name, provenance line, chevron) so it reads as part
 * of the same list. Clicking it opens the slide-in detail panel where the
 * install action lives. Renders nothing on Tauri builds for OS/architecture
 * pairs with no published binary.
 */
export const ThunderboltCliRow = ({ selected, onOpen, platform, architecture, tauri }: ThunderboltCliRowProps) => {
  const isTauriEnv = tauri ?? isTauri()
  const runtimeArchitecture = architecture ?? (isTauriEnv ? arch() : 'unknown')

  if (isTauriEnv && !canInstallThunderboltCli(platform ?? getPlatform(), runtimeArchitecture, isTauriEnv)) {
    return null
  }

  return (
    <Card data-testid="agent-row-thunderbolt-cli" className="border border-border p-0">
      <button
        type="button"
        onClick={onOpen}
        aria-label="Open Thunderbolt CLI"
        aria-pressed={selected}
        className={cn(
          'flex w-full cursor-pointer items-center gap-3 rounded-[inherit] px-4 py-3 text-left transition-colors',
          selected ? 'bg-accent' : 'hover:bg-secondary/50',
        )}
      >
        <div className="flex aspect-square size-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
          <Terminal className="size-5 text-muted-foreground" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-medium">Thunderbolt CLI</div>
          <div className="truncate text-[length:var(--font-size-sm)] text-muted-foreground">{cliProvenanceLine}</div>
        </div>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
    </Card>
  )
}

type ThunderboltCliDetailProps = {
  onClose: () => void
  /** Injectable installer (production omits; tests supply a fake). */
  install?: () => Promise<CliInstallResult>
  /** Test seam for the Tauri check; production reads `isTauri()`. */
  tauri?: boolean
}

/**
 * Slide-in detail panel for the Thunderbolt CLI — same header anatomy as the
 * agent details. On supported Tauri desktop builds the body offers one-click
 * install (download, checksum-verify, install into `~/.local/bin`) and then
 * renders the installed path (with a PATH hint if the dir isn't on `PATH`) or
 * a clear error, surfacing the manual build fallback when a release has no
 * CLI assets. Web builds link to the install guide instead.
 */
export const ThunderboltCliDetail = ({
  onClose,
  install = installThunderboltCli,
  tauri,
}: ThunderboltCliDetailProps) => {
  const [state, setState] = useState<InstallState>({ status: 'idle' })
  const [isPending, startTransition] = useTransition()

  const isTauriEnv = tauri ?? isTauri()

  const handleInstall = () => {
    startTransition(async () => {
      try {
        const result = await install()
        setState({ status: 'success', result })
      } catch (error) {
        const { message, showManualBuild } = describeCliInstallError(error)
        setState({ status: 'error', message, showManualBuild })
      }
    })
  }

  return (
    <section className="flex h-full flex-1 flex-col overflow-hidden px-4 pb-5 text-foreground md:px-6">
      <header className="relative flex h-[var(--touch-height-xl)] shrink-0 items-center justify-between gap-4 md:h-16">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex aspect-square size-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
            <Terminal className="size-5 text-muted-foreground" aria-hidden="true" />
          </div>
          <div className="flex min-w-0 flex-col justify-center leading-tight">
            <h2 className="min-w-0 truncate text-xl leading-tight text-foreground">Thunderbolt CLI</h2>
            <span className="truncate text-xs text-muted-foreground">{cliProvenanceLine}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5 md:absolute md:-right-4 md:top-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close details"
            className={mutedIconButtonClass}
          >
            <X className="size-4" />
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto pt-4">
        <div className="flex shrink-0 flex-col gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">About</h3>
          <p className="text-base leading-snug text-foreground">Use Thunderbolt from the command line.</p>
        </div>

        <div className="h-px shrink-0 bg-border/60" />

        <div className="flex flex-col gap-4">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Install</h3>
          {isTauriEnv ? (
            <>
              <Button variant="secondary" className="self-start" disabled={isPending} onClick={handleInstall}>
                {isPending ? <Loader2 className="animate-spin" /> : <Download />}
                {isPending ? 'Installing…' : 'Install CLI'}
              </Button>

              {state.status === 'success' && (
                <div className="flex flex-col gap-3">
                  <p className="flex items-center gap-2 text-[length:var(--font-size-sm)]">
                    <Check className="size-4 shrink-0 text-green-600" aria-hidden="true" />
                    Installed to <code className="font-mono">{state.result.path}</code>
                  </p>
                  {!state.result.onPath && state.result.pathHint && (
                    <div className="flex flex-col gap-2">
                      <p className="text-[length:var(--font-size-xs)] text-muted-foreground">
                        Add <code className="font-mono">~/.local/bin</code> to your PATH, then restart your shell:
                      </p>
                      <CopyCommandRow command={state.result.pathHint} label="Copy PATH command" />
                    </div>
                  )}
                </div>
              )}

              {state.status === 'error' && (
                <div className="flex flex-col gap-3">
                  <p className="flex items-start gap-2 text-[length:var(--font-size-sm)] text-destructive">
                    <AlertTriangle className="size-4 mt-0.5 shrink-0" aria-hidden="true" />
                    {state.message}
                  </p>
                  {state.showManualBuild && (
                    <div className="flex flex-col gap-2">
                      <p className="text-[length:var(--font-size-xs)] text-muted-foreground">
                        Build it from source instead (requires Bun):
                      </p>
                      <CopyCommandRow command={manualBuildCommand} label="Copy build command" />
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <Button asChild variant="secondary" className="self-start">
              <a href={cliInstallGuideUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink />
                View install guide
              </a>
            </Button>
          )}
        </div>
      </div>
    </section>
  )
}
