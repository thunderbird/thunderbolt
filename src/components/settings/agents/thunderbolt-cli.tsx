/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { arch } from '@tauri-apps/plugin-os'
import { AlertTriangle, Check, Download, ExternalLink, Loader2, Terminal } from 'lucide-react'
import { useState, useTransition } from 'react'
import { DetailDivider, DetailPanel, DetailSectionTitle } from '@/components/detail-panel'
import { CopyCommandRow } from '@/components/settings/copy-command-row'
import { Button } from '@/components/ui/button'
import {
  type CliInstallArchitecture,
  type CliInstallPlatform,
  type CliInstallResult,
  canInstallThunderboltCli,
  describeCliInstallError,
  installThunderboltCli,
} from '@/lib/cli-install'
import { getPlatform, isTauri } from '@/lib/platform'
import { AgentIconTile, AgentListRow } from './agent-list-row'

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
  isSelected?: boolean
  /** Opens the CLI detail panel. */
  onOpen: () => void
  /** Test seam for the runtime platform; production reads `getPlatform()`. */
  platform?: CliInstallPlatform
  /** Test seam for the runtime CPU architecture; production reads Tauri's OS plugin. */
  architecture?: CliInstallArchitecture
  /** Test seam for the Tauri check; production reads `isTauri()`. */
  isTauriEnv?: boolean
}

/**
 * List row for the standalone `thunderbolt` CLI agent — the exact anatomy of
 * an agent row (icon box, name, provenance line, chevron) so it reads as part
 * of the same list. Clicking it opens the slide-in detail panel where the
 * install action lives. Renders nothing on Tauri builds for OS/architecture
 * pairs with no published binary.
 */
export const ThunderboltCliRow = ({
  isSelected,
  onOpen,
  platform,
  architecture,
  isTauriEnv: isTauriEnvProp,
}: ThunderboltCliRowProps) => {
  const isTauriEnv = isTauriEnvProp ?? isTauri()
  const runtimeArchitecture = architecture ?? (isTauriEnv ? arch() : 'unknown')

  // Hide the row only on a Tauri build with no published binary for this
  // OS/architecture; web builds always show it (the detail links to the guide).
  if (isTauriEnv && !canInstallThunderboltCli(platform ?? getPlatform(), runtimeArchitecture)) {
    return null
  }

  return (
    <AgentListRow
      testId="agent-row-thunderbolt-cli"
      isSelected={isSelected}
      onOpen={onOpen}
      ariaLabel="Open Thunderbolt CLI"
      icon={<Terminal className="size-5 text-muted-foreground" aria-hidden="true" />}
      title="Thunderbolt CLI"
      subtitle={cliProvenanceLine}
    />
  )
}

type ThunderboltCliDetailProps = {
  onClose: () => void
  /** Injectable installer (production omits; tests supply a fake). */
  install?: () => Promise<CliInstallResult>
  /** Test seam for the Tauri check; production reads `isTauri()`. */
  isTauriEnv?: boolean
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
  isTauriEnv: isTauriEnvProp,
}: ThunderboltCliDetailProps) => {
  const [state, setState] = useState<InstallState>({ status: 'idle' })
  const [isPending, startTransition] = useTransition()

  const isTauriEnv = isTauriEnvProp ?? isTauri()

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
    <DetailPanel
      icon={
        <AgentIconTile>
          <Terminal className="size-5 text-muted-foreground" aria-hidden="true" />
        </AgentIconTile>
      }
      title="Thunderbolt CLI"
      subtitle={cliProvenanceLine}
      onClose={onClose}
    >
      <div className="flex shrink-0 flex-col gap-2">
        <DetailSectionTitle>About</DetailSectionTitle>
        <p className="text-base leading-snug text-foreground">Use Thunderbolt from the command line.</p>
      </div>

      <DetailDivider />

      <div className="flex flex-col gap-4">
        <DetailSectionTitle>Install</DetailSectionTitle>
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
    </DetailPanel>
  )
}
