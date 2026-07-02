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
 * A single `Editor` drives an async prompt worker: submit runs one turn to idle
 * with the editor's submit disabled, so turns never overlap. Raw mode disables
 * SIGINT, so Ctrl+C / Ctrl+D are intercepted manually to tear the TUI down and
 * restore the terminal.
 */

import type { AgentHarness } from '@earendil-works/pi-agent-core'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { EditorTheme, MarkdownTheme, SelectItem, SelectListTheme } from '@earendil-works/pi-tui'
import {
  Container,
  Editor,
  Key,
  Markdown,
  matchesKey,
  ProcessTerminal,
  SelectList,
  Spacer,
  Text,
  TUI,
} from '@earendil-works/pi-tui'
import { attachPermissionGate } from '../agent/permissions.ts'
import type { PermissionDecision, PermissionPrompt, PermissionRequest } from '../agent/types.ts'
import { bannerText } from '../banner.ts'
import { formatToolEnd, formatToolStart, formatTurnError } from './render.ts'
import { bold, cyan, dim, gray, italic, strikethrough, underline, yellow } from './theme.ts'

/** Composes two styling helpers, applying `inner` before `outer`. */
const compose =
  (outer: (t: string) => string, inner: (t: string) => string) =>
  (text: string): string =>
    outer(inner(text))

/** Markdown styling for the TUI, built from plain ANSI helpers so it needs no
 *  on-disk theme files (unlike pi-coding-agent's loader). */
const markdownTheme: MarkdownTheme = {
  heading: compose(bold, cyan),
  link: cyan,
  linkUrl: gray,
  code: yellow,
  codeBlock: (text) => text,
  codeBlockBorder: gray,
  quote: gray,
  quoteBorder: gray,
  hr: gray,
  listBullet: cyan,
  bold,
  italic,
  strikethrough,
  underline,
}

/** Select-list styling for permission prompts and the editor's autocomplete. */
const selectListTheme: SelectListTheme = {
  selectedPrefix: cyan,
  selectedText: compose(bold, cyan),
  description: gray,
  scrollInfo: gray,
  noMatch: gray,
}

/** Editor theme: a subdued border and the shared select-list styling. */
const editorTheme: EditorTheme = { borderColor: gray, selectList: selectListTheme }

/** Narrows a select value back to a {@link PermissionDecision}; anything
 *  unexpected fails closed to `deny`. */
const toDecision = (value: string): PermissionDecision =>
  value === 'allow-once' || value === 'allow-session' ? value : 'deny'

/** Renders a single assistant content block as markdown, or `undefined` for
 *  blocks with no prose (tool calls, blank text/thinking). */
const blockToMarkdown = (block: AssistantMessage['content'][number]): Markdown | undefined => {
  if (block.type === 'text' && block.text.trim()) return new Markdown(block.text.trim(), 1, 0, markdownTheme)
  if (block.type === 'thinking' && block.thinking.trim())
    return new Markdown(block.thinking.trim(), 1, 0, markdownTheme, { color: dim, italic: true })
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
 */
const subscribeRenderer = (harness: AgentHarness, tui: TUI, scrollback: Container): void => {
  let streaming: Container | undefined

  harness.subscribe((event) => {
    switch (event.type) {
      case 'message_start':
        if (event.message.role === 'assistant') {
          streaming = new Container()
          scrollback.addChild(streaming)
        }
        break
      case 'message_update':
      case 'message_end':
        if (streaming && event.message.role === 'assistant') {
          renderAssistantInto(streaming, event.message)
          tui.requestRender()
        }
        if (event.type === 'message_end') streaming = undefined
        break
      case 'tool_execution_start':
        scrollback.addChild(new Text(`\n${formatToolStart(event.toolName, event.args)}`))
        tui.requestRender()
        break
      case 'tool_execution_end':
        scrollback.addChild(new Text(formatToolEnd(event.isError, event.result)))
        tui.requestRender()
        break
      case 'turn_end': {
        // A turn that errors while streaming text has no dedicated error line,
        // so surface it here (the message body shows the raw prose, not the
        // provider error). Tool-call turns get the same treatment.
        const error = formatTurnError(event.message)
        if (error) {
          scrollback.addChild(new Text(`\n${error}`))
          tui.requestRender()
        }
        break
      }
    }
  })
}

/** Warning header shown above the permission choices. */
const formatPermissionHeader = (request: PermissionRequest): string => {
  const lines = [`\n${yellow(`⚠ allow ${request.toolName}?`)}`, `  ${request.summary}`]
  if (request.detail) lines.push('', request.detail)
  return lines.join('\n')
}

/**
 * Builds a TUI-backed permission prompt: an inline `SelectList` appended to the
 * scrollback and given focus, resolving the returned promise on the user's
 * choice. It replaces the readline prompt, which can't share stdin with the
 * TUI's raw mode. On resolve, focus returns to the editor.
 */
const buildAsk = (tui: TUI, scrollback: Container, editor: Editor): PermissionPrompt => {
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

      const finish = (decision: PermissionDecision): void => {
        scrollback.removeChild(list)
        tui.setFocus(editor)
        tui.requestRender()
        resolve(decision)
      }
      list.onSelect = (item) => finish(toDecision(item.value))
      list.onCancel = () => finish('deny')
    })
}

/**
 * Runs the interactive TUI REPL against a built harness until the user exits
 * (`exit`/`quit`, Ctrl+C, or Ctrl+D). Always tears the TUI down before
 * returning so the terminal never stays in raw mode, even on error.
 *
 * @param harness - the Pi harness driving the conversation
 * @param options.yolo - when true, auto-approve every tool call (no gate)
 */
export const runTuiRepl = async (harness: AgentHarness, options: { yolo: boolean }): Promise<void> => {
  const tui = new TUI(new ProcessTerminal())
  const scrollback = new Container()
  scrollback.addChild(new Text(bannerText()))
  const editor = new Editor(tui, editorTheme)
  tui.addChild(scrollback)
  tui.addChild(editor)
  tui.setFocus(editor)

  subscribeRenderer(harness, tui, scrollback)
  attachPermissionGate(harness, { yolo: options.yolo, ask: buildAsk(tui, scrollback, editor) })

  let settle: (error?: Error) => void = () => {}
  const done = new Promise<void>((resolve, reject) => {
    settle = (error) => (error ? reject(error) : resolve())
  })
  let exiting = false
  const requestExit = (error?: Error): void => {
    if (exiting) return
    exiting = true
    settle(error)
  }

  const runPrompt = async (text: string): Promise<void> => {
    editor.disableSubmit = true
    scrollback.addChild(new Text(`\n${gray(`› ${text}`)}`))
    tui.requestRender()
    try {
      await harness.prompt(text)
      await harness.waitForIdle()
    } finally {
      editor.disableSubmit = false
      tui.requestRender()
    }
  }

  editor.onSubmit = (text) => {
    const trimmed = text.trim()
    if (trimmed === '') return
    editor.setText('')
    editor.addToHistory(trimmed)
    if (trimmed === 'exit' || trimmed === 'quit') {
      requestExit()
      return
    }
    runPrompt(trimmed).catch((error) => requestExit(error instanceof Error ? error : new Error(String(error))))
  }

  const removeListener = tui.addInputListener((data) => {
    if (matchesKey(data, Key.ctrl('c')) || matchesKey(data, Key.ctrl('d'))) {
      requestExit()
      return { consume: true }
    }
    return undefined
  })

  tui.start()
  tui.requestRender()
  try {
    await done
  } finally {
    removeListener()
    tui.stop()
  }
}
