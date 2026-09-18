/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Interactive TUI for the thunderbolt REPL, built on `@earendil-works/pi-tui`.
 * It replaces the plain readline loop + stdout renderer whenever stdout is a
 * real terminal.
 *
 * Markdown rendering reuses pi-tui's `Markdown` component (the same engine
 * pi-coding-agent wraps), themed here with plain ANSI helpers. We deliberately
 * avoid pi-coding-agent's theme/component layer: its `initTheme` reads theme
 * JSON files from disk, which don't exist next to a `bun build --compile`
 * single binary and would crash on startup.
 *
 * The TUI owns stdin (raw mode) and stdout (differential renderer) for its whole
 * lifetime, so nothing else may write to either while it runs — assistant prose,
 * tool activity, the banner, and permission prompts all flow through components.
 * A single `Editor` drives one active turn while later submissions wait in the
 * visible message queue. Raw mode disables SIGINT, so interrupts and exits are
 * handled explicitly before the TUI restores the terminal.
 */

import { toError } from '@earendil-works/pi-agent-core'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { Component, EditorTheme, Focusable, MarkdownTheme, SelectItem, Terminal } from '@earendil-works/pi-tui'
import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  isKeyRelease,
  isKeyRepeat,
  Key,
  Loader,
  Markdown,
  matchesKey,
  ProcessTerminal,
  SelectList,
  Spacer,
  Text,
  TruncatedText,
  TUI,
  visibleWidth,
} from '@earendil-works/pi-tui'
import {
  attachPermissionGate,
  choosePermissionMode,
  cyclePermissionMode,
  type PermissionMode,
} from '../agent/permissions.ts'
import type { PermissionDecision, PermissionPrompt, PermissionRequest, ThinkingLevel } from '../agent/types.ts'
import { bannerText } from '../banner.ts'
import { createCommandRouter, mustApplyAfterCancellation, slashCommands } from '../provider-runtime/commands.ts'
import { runProviderManager } from '../provider-runtime/manager.ts'
import type {
  CommandOutcome,
  HarnessRuntime,
  InvocationSelection,
  ProviderManagerIO,
  ProviderRuntime,
} from '../provider-runtime/types.ts'
import { settleBestEffort } from '../lib/abort.ts'
import {
  formatToolEnd,
  formatToolStart,
  formatTurnError,
  isAssistantDelta,
  sanitizeTerminalText,
  type StatusPhase,
  statusLadderMessage,
  workingStatusText,
} from './render.ts'
import { bindAbort, createTuiProviderManagerIO, selectListTheme } from './provider-manager.ts'
import {
  amber,
  bold,
  boltYellow,
  brandGradient,
  cyan,
  dim,
  gray,
  italic,
  raspberry,
  red,
  spark,
  sparkFrames,
  strikethrough,
  symbols,
  underline,
} from './theme.ts'

/** Markdown styling for the TUI, built from plain ANSI helpers so it needs no
 *  on-disk theme files (unlike pi-coding-agent's loader). */
const markdownTheme: MarkdownTheme = {
  heading: (text) => bold(amber(text)),
  link: cyan,
  linkUrl: gray,
  code: amber,
  codeBlock: (text) => text,
  codeBlockBorder: gray,
  quote: gray,
  quoteBorder: gray,
  hr: gray,
  listBullet: raspberry,
  bold,
  italic,
  strikethrough,
  underline,
}

/** Editor theme: a subdued border and the shared select-list styling. */
const editorTheme: EditorTheme = { borderColor: gray, selectList: selectListTheme }

const providerSetupCancellation = (): Error =>
  new Error('Provider setup was cancelled before a provider was selected.')

/** Reports one detached operation failure without leaving an unhandled rejection. */
const reportDetachedFailure = async (operation: Promise<void>, report: (error: Error) => void): Promise<void> => {
  try {
    await operation
  } catch (error) {
    report(toError(error))
  }
}

/** Narrows a select value back to a {@link PermissionDecision}; anything
 *  unexpected fails closed to `deny`. */
const toDecision = (value: string): PermissionDecision =>
  value === 'allow-once' || value === 'allow-session' ? value : 'deny'

/** Renders a single assistant content block as markdown, or `undefined` for
 *  blocks with no prose (tool calls, blank text/thinking). */
const blockToMarkdown = (block: AssistantMessage['content'][number]): Markdown | undefined => {
  if (block.type === 'text' && block.text.trim())
    return new Markdown(sanitizeTerminalText(block.text.trim()), 1, 0, markdownTheme)
  if (block.type === 'thinking' && block.thinking.trim())
    return new Markdown(
      `${symbols.thinking} thinking\n${sanitizeTerminalText(block.thinking.trim())}`,
      1,
      0,
      markdownTheme,
      { color: dim, italic: true },
    )
  return undefined
}

/**
 * Rebuilds `container` to show an assistant message's prose and thinking as
 * markdown. Tool calls are rendered separately (as tool-activity lines), so only
 * text/thinking blocks are drawn here.
 */
const renderAssistantInto = (container: Container, message: AssistantMessage): void => {
  container.clear()
  const blocks = message.content.map(blockToMarkdown).filter((block): block is Markdown => block !== undefined)
  if (blocks.length === 0) return
  // A blank line separates the turn from the prompt above — added only when
  // there's prose to show, so a tool-only turn stays flush.
  container.addChild(new Spacer(1))
  for (const block of blocks) container.addChild(block)
}

/**
 * Subscribes a component-based renderer to the harness for the TUI's lifetime.
 * Assistant prose/thinking renders as markdown; tool activity and turn errors
 * reuse the plain-mode formatters wrapped in `Text`. Each new component is
 * appended to `scrollback` in event order, so the transcript reads top-to-bottom
 * like the plain renderer.
 *
 * @returns cleanup that unsubscribes and stops any live status Loader
 */
export const subscribeTuiRenderer = (
  harness: Pick<HarnessRuntime, 'currentProviderId' | 'subscribe'>,
  tui: TUI,
  scrollback: Container,
  statusContainer: Container,
  onAgentEnd?: () => void,
): (() => void) => {
  let streaming: Container | undefined
  let status: Loader | undefined
  let statusPhase: StatusPhase = 'working'
  let statusStartedAt = 0
  let statusTicker: ReturnType<typeof setInterval> | undefined
  let turnActive = false
  const updateStatus = (): void => {
    status?.setMessage(statusLadderMessage(statusStartedAt, Date.now(), statusPhase))
  }
  const showStatus = (phase: StatusPhase): void => {
    statusPhase = phase
    if (status) {
      updateStatus()
    } else {
      statusStartedAt = Date.now()
      status = new Loader(tui, boltYellow, (text) => text, workingStatusText, {
        frames: sparkFrames(),
        intervalMs: 600,
      })
      statusContainer.addChild(status)
      statusTicker = setInterval(updateStatus, 1_000)
      statusTicker.unref()
    }
    tui.requestRender()
  }
  const clearStatus = (): void => {
    if (!status) return
    status.stop()
    status = undefined
    if (statusTicker) clearInterval(statusTicker)
    statusTicker = undefined
    statusContainer.clear()
    tui.requestRender()
  }

  const unsubscribe = harness.subscribe((event) => {
    switch (event.type) {
      case 'agent_start':
      case 'turn_start':
        turnActive = true
        showStatus('working')
        break
      case 'message_start':
        if (event.message.role === 'assistant') {
          streaming = new Container()
          scrollback.addChild(streaming)
        }
        break
      case 'message_update':
        if (streaming && event.message.role === 'assistant') {
          if (event.assistantMessageEvent.type === 'thinking_start') showStatus('reasoning')
          if (isAssistantDelta(event.assistantMessageEvent)) clearStatus()
          renderAssistantInto(streaming, event.message)
          tui.requestRender()
        }
        break
      case 'message_end':
        if (event.message.role === 'assistant') clearStatus()
        if (streaming && event.message.role === 'assistant') {
          renderAssistantInto(streaming, event.message)
          tui.requestRender()
        }
        streaming = undefined
        break
      case 'tool_execution_start':
        clearStatus()
        scrollback.addChild(new Text(`\n${formatToolStart(event.toolName, event.args, tui.terminal.columns)}`))
        tui.requestRender()
        break
      case 'tool_execution_end':
        scrollback.addChild(new Text(formatToolEnd(event.isError, event.result, tui.terminal.columns)))
        tui.requestRender()
        break
      case 'turn_end': {
        turnActive = false
        clearStatus()
        // A turn that errors while streaming text has no dedicated error line,
        // so surface it here (the message body shows the raw prose, not the
        // provider error). Tool-call turns get the same treatment.
        const error = formatTurnError(event.message, harness.currentProviderId())
        if (error) {
          scrollback.addChild(new Text(`\n${error}`))
          tui.requestRender()
        }
        break
      }
      case 'agent_end':
        turnActive = false
        clearStatus()
        onAgentEnd?.()
        break
      case 'abort':
        clearStatus()
        if (turnActive) {
          turnActive = false
          scrollback.addChild(new Text(dim(`${symbols.interrupted} Interrupted — partial reply kept`)))
          tui.requestRender()
        }
        break
    }
  })
  return () => {
    unsubscribe()
    clearStatus()
  }
}

/** Warning header shown above the permission choices. */
const formatPermissionHeader = (request: PermissionRequest): string => {
  const lines = [`\n${boltYellow('⚠')} ${bold(request.toolName)} ${dim('wants to run')}`, `    ${bold(request.summary)}`]
  if (request.detail) lines.push('', request.detail)
  return lines.join('\n')
}

/**
 * Builds a TUI-backed permission prompt: an inline `SelectList` appended to the
 * scrollback and given focus, resolving the returned promise on the user's
 * choice. It replaces the readline prompt, which can't share stdin with the
 * TUI's raw mode. On resolve, focus returns to the editor.
 */
export const buildTuiPermissionPrompt = (
  tui: TUI,
  scrollback: Container,
  editor: Editor,
  activeSignal: () => AbortSignal | undefined,
): PermissionPrompt => {
  return (request) =>
    new Promise<PermissionDecision>((resolve) => {
      const items: SelectItem[] = [
        { value: 'allow-once', label: 'Allow once' },
        { value: 'allow-session', label: `Allow ${request.toolName} for the rest of this session` },
        { value: 'deny', label: 'Deny' },
      ]
      scrollback.addChild(new Text(formatPermissionHeader(request)))
      const list = new SelectList(items, items.length, selectListTheme)
      scrollback.addChild(list)
      tui.setFocus(list)
      tui.requestRender()

      let finished = false
      const finish = (decision: PermissionDecision): void => {
        if (finished) return
        finished = true
        removeAbortListener()
        scrollback.removeChild(list)
        tui.setFocus(editor)
        tui.requestRender()
        resolve(decision)
      }
      list.onSelect = (item) => finish(toDecision(item.value))
      list.onCancel = () => finish('deny')
      const removeAbortListener = bindAbort(activeSignal(), () => finish('deny'))
    })
}

type ModelPresentation = { readonly id: string; readonly label: string; readonly confidential: boolean }

/** Resolves either a catalog id or wire model to its footer presentation. */
const modelPresentation = (
  runtime: Pick<ProviderRuntime, 'snapshot'>,
  model: string,
): ModelPresentation => {
  const snapshot = runtime.snapshot()
  const items = [snapshot.thunderbolt.models ?? [], ...snapshot.providers.map((provider) => provider.models ?? [])]
  const match = items
    .flat()
    .find((item) => item.id === model || item.wireModel === model)
  return {
    id: match?.id ?? model,
    label: match?.label ?? model,
    confidential: match?.confidential ?? false,
  }
}

type FooterIdentity = {
  readonly model: string
  readonly confidential: boolean
  readonly thinking: ThinkingLevel
  readonly permissionMode: PermissionMode
}

type FooterHintState = 'idle' | 'active' | 'active-queue' | 'autocomplete' | 'models' | 'quit-confirm'

const thinkingLabel = {
  off: 'off',
  minimal: 'min',
  low: 'low',
  medium: 'med',
  high: 'high',
  xhigh: 'xhigh',
} as const satisfies Readonly<Record<ThinkingLevel, string>>

/** Styles one footer key and its subdued action label. */
const keyHint = (key: string, label: string): string => `${amber(key)}${dim(` ${label}`)}`

/** Selects the wide or essential footer hint for the current interaction state. */
const footerHint = (state: FooterHintState, narrow: boolean): string => {
  if (state === 'quit-confirm') return boltYellow('ctrl+c again to quit')
  if (state === 'active') return `${keyHint('enter', 'queue')} ${dim('·')} ${keyHint('esc', 'interrupt')}`
  if (state === 'active-queue')
    return `${keyHint('enter', 'queue')} ${dim('·')} ${keyHint('↑', 'queue list')} ${dim('·')} ${keyHint('esc', 'interrupt')}`
  if (state === 'models') return keyHint('esc', 'close')
  if (state === 'autocomplete')
    return narrow ? keyHint('esc', 'dismiss') : `${keyHint('tab', 'complete')} ${dim('·')} ${keyHint('esc', 'dismiss')}`
  return narrow ? keyHint('ctrl+c', 'quit') : `${keyHint('/', 'commands')} ${dim('·')} ${keyHint('ctrl+c', 'quit')}`
}

/** Persistent single-line model identity and context-sensitive key hints. */
export class Footer implements Component {
  constructor(
    private identity: FooterIdentity,
    private readonly hintState: () => FooterHintState,
  ) {}

  setIdentity(identity: FooterIdentity): void {
    this.identity = identity
  }

  setPermissionMode(permissionMode: PermissionMode): void {
    this.identity = { ...this.identity, permissionMode }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const narrow = width < 60
    const permissionLabel = narrow ? 'mode' : 'permissions'
    const permissionModeStyle = this.identity.permissionMode === 'yolo' ? red : raspberry
    const permissionMode =
      this.identity.permissionMode === 'ask'
        ? dim(`${permissionLabel} ask`)
        : `${dim(`${permissionLabel} `)}${permissionModeStyle(this.identity.permissionMode)}`
    const left = narrow
      ? `${spark()} ${permissionMode}`
      : `${spark()} ${amber(this.identity.model)}${dim(
          `${this.identity.confidential ? ' · confidential' : ''} · thinking ${thinkingLabel[this.identity.thinking]} · `,
        )}${permissionMode}`
    const right = footerHint(this.hintState(), narrow)
    const rightWidth = visibleWidth(right)
    if (rightWidth >= width) return new TruncatedText(right).render(width)
    const leftWidth = width - rightWidth - 1
    const leftLine = new TruncatedText(left).render(leftWidth)[0] ?? ''
    return new Text(`${leftLine} ${right}`, 0, 0).render(width).slice(0, 1)
  }
}

const queueHint = '↑ select · enter send now · ⌫ remove · esc back'

class MessageQueue implements Component, Focusable {
  focused = false
  private selectedIndex = 0
  private readonly items: string[] = []
  private sending = false

  constructor(
    private readonly onSendNow: (text: string) => Promise<boolean>,
    private readonly onSendFailure: (error: Error) => void,
    private readonly onUpdate: () => void,
    private readonly onExit: () => void,
  ) {}

  enqueue(text: string): void {
    this.items.push(text)
  }

  dequeue(): string | undefined {
    const text = this.items.shift()
    this.afterRemoval()
    return text
  }

  hasItems(): boolean {
    return this.items.length > 0
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (!this.hasItems()) return []
    const title = bold(`Queued (${this.items.length})`)
    const hint = dim(queueHint)
    const gap = width - visibleWidth(title) - visibleWidth(hint)
    const header =
      gap > 0
        ? new TruncatedText(`${title}${' '.repeat(gap)}${hint}`).render(width)
        : [...new TruncatedText(title).render(width), ...new Text(hint, 0, 0).render(width)]
    const items = this.items.map((text, index) => {
      const selected = this.focused && index === this.selectedIndex
      const line = new TruncatedText(
        `${selected ? '> ' : '  '}${index + 1}. ${sanitizeTerminalText(text).replace(/\s+/g, ' ').trim()}`,
      ).render(width)[0] ?? ''
      return selected ? selectListTheme.selectedText(line) : line
    })
    return [...header, ...items]
  }

  handleInput(data: string): void {
    if (this.sending) return
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1)
      return
    }
    if (matchesKey(data, Key.down)) {
      if (this.selectedIndex === this.items.length - 1) {
        this.onExit()
        return
      }
      this.selectedIndex += 1
      return
    }
    if (matchesKey(data, Key.enter)) {
      void reportDetachedFailure(this.sendSelected(), this.onSendFailure)
      return
    }
    if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
      this.removeSelected()
      return
    }
    if (matchesKey(data, Key.escape)) this.onExit()
  }

  private async sendSelected(): Promise<void> {
    const index = this.selectedIndex
    const text = this.items[index]
    if (text === undefined) return

    this.sending = true
    try {
      if (!(await this.onSendNow(text))) return
      this.items.splice(index, 1)
      this.afterRemoval()
      this.onUpdate()
    } finally {
      this.sending = false
    }
  }

  private removeSelected(): string | undefined {
    const [text] = this.items.splice(this.selectedIndex, 1)
    this.afterRemoval()
    return text
  }

  private afterRemoval(): void {
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.items.length - 1))
    if (!this.hasItems()) this.onExit()
  }
}

/** Sanitizes only the terminal echo; command routing still receives the original editor text. */
export const formatTuiInputEcho = (text: string): string =>
  `${bold(brandGradient('›'))} ${sanitizeTerminalText(text)}`

/** @deprecated Retained until the out-of-scope run tests migrate to the editor submission path. */
export const submitTuiText = (
  text: string,
  callbacks: {
    readonly clear: () => void
    readonly remember: (text: string) => void
    readonly run: (text: string) => void
  },
): boolean => {
  const historyText = text.trim()
  if (historyText === '') return false
  callbacks.clear()
  callbacks.remember(historyText)
  callbacks.run(text)
  return true
}

/**
 * Runs the interactive TUI REPL, connecting before enabling prompts, until the
 * user exits (`exit`/`quit`, Ctrl+C, or Ctrl+D). Always tears the TUI down so
 * the terminal never stays in raw mode, even on connection failure.
 *
 * @param runtime - provider state and preparation used by manager commands
 * @param options.connect - provider bootstrap and harness construction hosted by this TUI
 * @param options.initialPermissionMode - permission mode selected for this launch
 * @param options.fullscreen - when true, own the alternate screen for the session
 * @param options.applyOutcome - the sole live transition/persistence owner
 */
export const runTuiRepl = async (
  runtime: ProviderRuntime,
  options: {
    readonly connect: (
      io: ProviderManagerIO,
      signal: AbortSignal,
    ) => Promise<{ readonly harness: HarnessRuntime; readonly model: string }>
    readonly initialPermissionMode: PermissionMode
    readonly fullscreen: boolean
    readonly thinking: ThinkingLevel
    readonly terminal?: Terminal
    readonly applyOutcome: (
      outcome: CommandOutcome,
      harness: HarnessRuntime,
      signal: AbortSignal,
    ) => Promise<InvocationSelection | null>
  },
): Promise<void> => {
  const terminal = options.terminal ?? new ProcessTerminal()
  terminal.write(options.fullscreen ? '\x1b[?1049h\x1b[2J\x1b[H' : '\x1b[2J\x1b[H')
  const tui = new TUI(terminal)
  const scrollback = new Container()
  scrollback.addChild(new Text(bannerText(terminal.columns)))
  const statusContainer = new Container()
  const queueContainer = new Container()
  const editor = new Editor(tui, editorTheme)
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider(slashCommands, process.cwd()))
  editor.disableSubmit = true
  const connectController = new AbortController()
  let activeController: AbortController | undefined = connectController
  let activeOperation: Promise<void> | undefined
  let harness: HarnessRuntime | undefined
  let queue: MessageQueue | undefined
  let cleanupRenderer: (() => void) | undefined
  let currentModel: string | undefined
  let permissionMode = options.initialPermissionMode
  let quitArmed = false
  let quitResetTimer: ReturnType<typeof setTimeout> | undefined
  const footer = new Footer(
    {
      model: 'not connected',
      confidential: false,
      thinking: options.thinking,
      permissionMode,
    },
    () => {
      if (quitArmed) return 'quit-confirm'
      if (activeController) return queue?.hasItems() ? 'active-queue' : 'active'
      if (tui.hasOverlay()) return 'models'
      return editor.isShowingAutocomplete() ? 'autocomplete' : 'idle'
    },
  )
  tui.addChild(scrollback)
  tui.addChild(statusContainer)
  tui.addChild(queueContainer)
  tui.addChild(editor)
  tui.addChild(footer)
  tui.setFocus(editor)

  const managerIO = createTuiProviderManagerIO(
    tui,
    scrollback,
    editor,
    () => activeController?.signal,
    () => currentModel === undefined ? undefined : modelPresentation(runtime, currentModel).id,
  )

  const done = Promise.withResolvers<void>()
  let exiting = false
  const requestExit = (error?: Error): void => {
    if (exiting) return
    exiting = true
    activeController?.abort()
    if (harness) void settleBestEffort(harness.abort())
    if (error) done.reject(error)
    else done.resolve()
  }

  const removeListener = tui.addInputListener((data) => {
    if (matchesKey(data, Key.shift('tab'))) {
      if (isKeyRelease(data) || isKeyRepeat(data)) return { consume: true }
      permissionMode = cyclePermissionMode(permissionMode)
      footer.setPermissionMode(permissionMode)
      tui.requestRender()
      return { consume: true }
    }
    if (matchesKey(data, Key.up) && editor.focused && queue?.hasItems()) {
      tui.setFocus(queue)
      tui.requestRender()
      return { consume: true }
    }
    if (matchesKey(data, Key.escape) && queue?.focused) return undefined
    if (matchesKey(data, Key.escape) && activeController) {
      activeController.abort(activeController === connectController ? providerSetupCancellation() : undefined)
      if (harness) void settleBestEffort(harness.abort())
      return { consume: true }
    }
    if (matchesKey(data, Key.ctrl('d'))) {
      requestExit()
      return { consume: true }
    }
    if (matchesKey(data, Key.ctrl('c'))) {
      if (quitArmed) {
        quitArmed = false
        if (quitResetTimer) clearTimeout(quitResetTimer)
        requestExit()
        return { consume: true }
      }
      quitArmed = true
      activeController?.abort(activeController === connectController ? providerSetupCancellation() : undefined)
      if (activeController && harness) void settleBestEffort(harness.abort())
      if (quitResetTimer) clearTimeout(quitResetTimer)
      quitResetTimer = setTimeout(() => {
        quitArmed = false
        tui.requestRender()
      }, 2_000)
      quitResetTimer.unref()
      tui.requestRender()
      return { consume: true }
    }
    return undefined
  })

  tui.start()
  tui.requestRender(true)
  try {
    const connected = await options.connect(managerIO, connectController.signal)
    harness = connected.harness
    if (connectController.signal.aborted) throw providerSetupCancellation()
    currentModel = connected.model
    attachPermissionGate(harness, {
      getMode: () => permissionMode,
      ask: buildTuiPermissionPrompt(tui, scrollback, editor, () => activeController?.signal),
    })
    const router = createCommandRouter(
      (mode) => runProviderManager(managerIO, runtime, mode, activeController?.signal, connected.harness.currentProviderId),
      async () => {
        permissionMode = await choosePermissionMode(managerIO, permissionMode)
        footer.setPermissionMode(permissionMode)
        tui.requestRender()
        return { kind: 'handled' }
      },
    )
    const selectedModel = modelPresentation(runtime, currentModel)
    footer.setIdentity({
      model: selectedModel.label,
      confidential: selectedModel.confidential,
      thinking: options.thinking,
      permissionMode,
    })
    activeController = undefined
    editor.disableSubmit = false
    let agentEnded = false

    const renderError = (error: Error): void => {
      const detail = sanitizeTerminalText(error.message)
      scrollback.addChild(new Text(`\n${red(`${symbols.fail} ${detail}`)}`))
      tui.requestRender()
    }

    const runInput = async (text: string, signal: AbortSignal): Promise<void> => {
      scrollback.addChild(new Text(`\n${formatTuiInputEcho(text)}`))
      tui.requestRender()
      try {
        const outcome = await router.handle(text)
        if (signal.aborted && !mustApplyAfterCancellation(outcome)) return
        if (outcome.kind === 'exit') {
          requestExit()
          return
        }
        const selection = await options.applyOutcome(outcome, connected.harness, signal)
        if (selection?.model !== undefined) {
          currentModel = selection.model
          const model = modelPresentation(runtime, currentModel)
          footer.setIdentity({
            model: model.label,
            confidential: model.confidential,
            thinking: options.thinking,
            permissionMode,
          })
        }
      } catch (error) {
        if (signal.aborted) return
        renderError(toError(error))
      } finally {
        if (activeController?.signal === signal) activeController = undefined
        const shouldDrain = agentEnded && !signal.aborted
        agentEnded = false
        if (shouldDrain) {
          const next = messageQueue.dequeue()
          if (next !== undefined) startInput(next)
        }
        tui.requestRender()
      }
    }

    const startInput = (text: string): void => {
      const controller = new AbortController()
      activeController = controller
      const operation = runInput(text, controller.signal)
      activeOperation = operation
      void reportDetachedFailure(operation, requestExit)
    }

    const messageQueue = new MessageQueue(
      async (text) => {
        if (activeController?.signal.aborted) return false
        if (activeController) {
          await connected.harness.steer(text)
          scrollback.addChild(new Text(`\n${dim(`[steering] ${sanitizeTerminalText(text)}`)}`))
          return true
        }
        startInput(text)
        return true
      },
      renderError,
      () => tui.requestRender(),
      () => {
        tui.setFocus(editor)
      },
    )
    queue = messageQueue
    queueContainer.addChild(messageQueue)
    cleanupRenderer = subscribeTuiRenderer(harness, tui, scrollback, statusContainer, () => {
      agentEnded = true
    })
    tui.requestRender(true)

    editor.onSubmit = (text) => {
      const historyText = text.trim()
      if (historyText === '') return
      editor.setText('')
      editor.addToHistory(historyText)
      if (activeController) {
        messageQueue.enqueue(text)
        scrollback.addChild(new Text(`\n${dim(`[queued] ${sanitizeTerminalText(text)}`)}`))
        return
      }
      startInput(text)
    }

    await done.promise
  } catch (error) {
    const detail = sanitizeTerminalText(toError(error).message)
    scrollback.addChild(new Text(`\n${red(`${symbols.fail} ${detail}`)}`))
    tui.requestRender(true)
    await new Promise<void>((resolve) => process.nextTick(resolve))
    throw error
  } finally {
    removeListener()
    if (quitResetTimer) clearTimeout(quitResetTimer)
    activeController?.abort()
    const abort = harness ? settleBestEffort(harness.abort()) : undefined
    if (activeOperation) await settleBestEffort(activeOperation)
    if (abort) await abort
    cleanupRenderer?.()
    tui.stop()
    if (options.fullscreen) terminal.write('\x1b[?1049l')
  }
}
