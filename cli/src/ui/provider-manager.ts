/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { spawn } from 'node:child_process'
import type { Editor, TUI } from '@earendil-works/pi-tui'
import {
  Box,
  CancellableLoader,
  Input,
  Key,
  matchesKey,
  SelectList,
  Spacer,
  Text,
  type Container,
  type SelectListTheme,
} from '@earendil-works/pi-tui'
import type { DeviceGrantPresentation, ProviderManagerIO, ProviderManagerItem } from '../provider-runtime/types.ts'
import type { TerminalIO } from './prompt.ts'
import { sanitizeTerminalText } from './render.ts'
import {
  amber,
  bold,
  boltYellow,
  brandGradient,
  dim,
  green,
  overlayBackground,
  raspberry,
  red,
  sparkFrames,
  symbols,
} from './theme.ts'

type BrowserOpener = (url: string) => void | Promise<void>

export const authBrowserPrompt = 'Press Enter to open your browser'

/** Opens a URL without keeping the CLI or browser process attached to each other. */
const openBrowser: BrowserOpener = (url) => {
  const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], {
    detached: true,
    stdio: 'ignore',
  })
  child.once('error', () => {})
  child.unref()
}

/** Keeps browser-launch failures from blocking the printed fallback URL. */
const openQuietly = async (opener: BrowserOpener, url: string): Promise<void> => {
  try {
    await opener(url)
  } catch {}
}

/** Invokes one UI cancellation callback once and releases its abort listener. */
export const bindAbort = (signal: AbortSignal | undefined, cancel: () => void): (() => void) => {
  if (signal === undefined) return () => {}
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) queueMicrotask(cancel)
  return () => signal.removeEventListener('abort', cancel)
}

export const selectListTheme: SelectListTheme = {
  selectedPrefix: brandGradient,
  selectedText: (text) => bold(raspberry(text)),
  description: dim,
  scrollInfo: dim,
  noMatch: dim,
}

/** Formats the device-grant verification block identically in plain and TUI modes. */
const formatVerification = (value: Parameters<DeviceGrantPresentation['showVerification']>[0]): string => {
  const lines = [`  ${dim('code')}   ${bold(value.userCode)}`, `  ${dim(`didn't open?  ${value.verificationUrl}`)}`]
  if (value.qrBlock) lines.push(value.qrBlock)
  return `${lines.join('\n')}\n`
}

/** Formats one device-grant status without changing the account client's message. */
const formatStatus = (...[status, message]: Parameters<DeviceGrantPresentation['showStatus']>): string => {
  const detail = message ?? ''
  if (status === 'success') return `${green(symbols.ok)} ${detail}\n`
  if (status === 'error') return `${red(symbols.fail)} ${detail}\n`
  return `${boltYellow(symbols.spark)} ${detail}\n`
}

/** Formats an auth wait as the mockup's compact minutes:seconds clock. */
const elapsedClock = (startedAt: number): string => {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1_000))
  return `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, '0')}`
}

/** Creates the numbered provider-manager menu used before a harness owns the terminal. */
const choosePlain = async (
  terminal: Pick<TerminalIO, 'readLine' | 'readSecret' | 'write'> & { readonly isTTY?: boolean },
  title: string,
  items: readonly ProviderManagerItem[],
): Promise<string | null> => {
  terminal.write(`${sanitizeTerminalText(title)}:\n`)
  items.forEach((item, index) => {
    const label = sanitizeTerminalText(item.label)
    const description = item.description ? ` — ${sanitizeTerminalText(item.description)}` : ''
    terminal.write(`  ${index + 1}. ${label}${description}\n`)
  })

  while (true) {
    const answer = await terminal.readLine(`Choice [1-${items.length}]: `)
    if (answer === null) return null
    const choice = /^\d+$/.test(answer.trim()) ? items[Number(answer.trim()) - 1] : undefined
    if (choice) return choice.id
    terminal.write(`Enter a number from 1 to ${items.length}.\n`)
  }
}

/** Adapts the existing hidden-input setup terminal to the shared provider manager. */
export const createPlainProviderManagerIO = (
  terminal: Pick<TerminalIO, 'readLine' | 'readSecret' | 'write'> & { readonly isTTY?: boolean },
  opener: BrowserOpener = openBrowser,
): ProviderManagerIO => {
  const io: ProviderManagerIO = {
    choose: (title, items) => choosePlain(terminal, title, items),
    readText: (prompt) => terminal.readLine(sanitizeTerminalText(prompt)),
    readSecret: (prompt) => terminal.readSecret(sanitizeTerminalText(prompt)),
    write: (text) => terminal.write(sanitizeTerminalText(text)),
    showVerification: (value) => terminal.write(sanitizeTerminalText(formatVerification(value))),
    showStatus: (...value) => terminal.write(sanitizeTerminalText(formatStatus(...value))),
  }
  if (!('isTTY' in terminal) || terminal.isTTY !== true) return io
  return {
    ...io,
    promptToOpenBrowser: async (url) => {
      if ((await terminal.readLine(authBrowserPrompt)) === null) return
      await openQuietly(opener, url)
    },
  }
}

/** A single-line input that keeps its value in memory but renders only bullets. */
class MaskedInput extends Input {
  override render(width: number): string[] {
    const value = this.getValue()
    this.setValue('•'.repeat([...value].length))
    try {
      return super.render(width)
    } finally {
      this.setValue(value)
    }
  }
}

/** Appends text to TUI scrollback and requests a differential render. */
const appendText = (tui: TUI, scrollback: Container, text: string): void => {
  scrollback.addChild(new Text(sanitizeTerminalText(text).replace(/\n$/, '')))
  tui.requestRender()
}

/** Presents one focused TUI select list and restores the shared editor afterward. */
const chooseTui = (
  tui: TUI,
  scrollback: Container,
  editor: Editor,
  title: string,
  items: readonly ProviderManagerItem[],
  signal?: AbortSignal,
): Promise<string | null> =>
  new Promise((resolve) => {
    appendText(tui, scrollback, `${title}:`)
    const list = new SelectList(
      items.map((item) => ({
        value: item.id,
        label: sanitizeTerminalText(item.label),
        description: item.description ? sanitizeTerminalText(item.description) : undefined,
      })),
      Math.min(items.length, 10),
      selectListTheme,
    )
    scrollback.addChild(list)
    tui.setFocus(list)
    tui.requestRender()

    let finished = false
    const finish = (value: string | null, label?: string): void => {
      if (finished) return
      finished = true
      removeAbortListener()
      scrollback.removeChild(list)
      if (label) scrollback.addChild(new Text(`  ${label}`))
      tui.setFocus(editor)
      tui.requestRender()
      resolve(value)
    }
    list.onSelect = (item) => finish(item.value, item.label)
    list.onCancel = () => finish(null)
    const removeAbortListener = bindAbort(signal, () => finish(null))
  })

/** Background-tinted model picker that forwards captured input to its SelectList. */
class ModelsOverlay extends Box {
  constructor(readonly list: SelectList) {
    super(1, 1, overlayBackground)
    this.addChild(new Text(`${bold('Switch model')}  ${dim('· esc close')}`, 0, 0))
    this.addChild(new Spacer(1))
    this.addChild(list)
    this.addChild(new Spacer(1))
    this.addChild(new Text(`${dim('↑↓ choose ·')} ${amber('enter')} ${dim('switch')}`, 0, 0))
  }

  handleInput(data: string): void {
    this.list.handleInput(data)
  }
}

/** Presents /models as a focus-capturing bottom-center overlay. */
const chooseModelsOverlay = (
  tui: TUI,
  items: readonly ProviderManagerItem[],
  activeModel: string | undefined,
  signal?: AbortSignal,
): Promise<string | null> =>
  new Promise((resolve) => {
    const list = new SelectList(
      items.map((item) => ({
        value: item.id,
        label: sanitizeTerminalText(item.label),
        description:
          item.id === activeModel
            ? `${item.description ? `${sanitizeTerminalText(item.description)} · ` : ''}${amber('active')}`
            : item.description
              ? sanitizeTerminalText(item.description)
              : undefined,
      })),
      Math.min(items.length, 10),
      selectListTheme,
    )
    const overlay = new ModelsOverlay(list)
    const handle = tui.showOverlay(overlay, { anchor: 'bottom-center', width: '70%', offsetY: -3 })

    let finished = false
    const finish = (value: string | null): void => {
      if (finished) return
      finished = true
      removeAbortListener()
      handle.hide()
      resolve(value)
    }
    list.onSelect = (item) => finish(item.value)
    list.onCancel = () => finish(null)
    const removeAbortListener = bindAbort(signal, () => finish(null))
  })

/** Temporarily gives the shared editor to one provider-manager text prompt. */
const readTuiText = (
  tui: TUI,
  scrollback: Container,
  editor: Editor,
  prompt: string,
  signal?: AbortSignal,
): Promise<string | null> =>
  new Promise((resolve) => {
    appendText(tui, scrollback, prompt)
    const previousSubmit = editor.onSubmit
    const previousDisableSubmit = editor.disableSubmit
    const previousText = editor.getText()
    editor.setText('')
    editor.disableSubmit = false
    tui.setFocus(editor)

    let finished = false
    const finish = (value: string | null): void => {
      if (finished) return
      finished = true
      removeAbortListener()
      removeEscapeListener()
      editor.onSubmit = previousSubmit
      editor.disableSubmit = previousDisableSubmit
      editor.setText(value === null ? previousText : '')
      tui.setFocus(editor)
      tui.requestRender()
      resolve(value)
    }
    const removeEscapeListener = tui.addInputListener((data) => {
      if (!matchesKey(data, Key.escape)) return undefined
      finish(null)
      return { consume: true }
    })
    editor.onSubmit = (value) => finish(value)
    const removeAbortListener = bindAbort(signal, () => finish(null))
    tui.requestRender()
  })

/** Presents a masked TUI input and restores focus to the shared editor afterward. */
const readTuiSecret = (
  tui: TUI,
  scrollback: Container,
  editor: Editor,
  prompt: string,
  signal?: AbortSignal,
): Promise<string | null> =>
  new Promise((resolve) => {
    appendText(tui, scrollback, prompt)
    const input = new MaskedInput()
    scrollback.addChild(input)
    tui.setFocus(input)
    tui.requestRender()

    let finished = false
    const finish = (value: string | null): void => {
      if (finished) return
      finished = true
      removeAbortListener()
      input.setValue('')
      scrollback.removeChild(input)
      tui.setFocus(editor)
      tui.requestRender()
      resolve(value)
    }
    input.onSubmit = (value) => finish(value)
    input.onEscape = () => finish(null)
    const removeAbortListener = bindAbort(signal, () => finish(null))
  })

type AuthWaitState = {
  readonly loader: CancellableLoader
  readonly hint: Text
  readonly ticker: ReturnType<typeof setInterval>
  readonly removeInput: () => void
  removeAbort: () => void
}

/** Creates provider-manager presentation that stays entirely inside an active TUI. */
export const createTuiProviderManagerIO = (
  tui: TUI,
  scrollback: Container,
  editor: Editor,
  activeSignal: () => AbortSignal | undefined = () => undefined,
  activeModel?: () => string | undefined,
  opener: BrowserOpener = openBrowser,
): ProviderManagerIO => {
  let browserUrl: string | undefined
  let authWait: AuthWaitState | undefined
  const clearAuthWait = (): void => {
    const waiting = authWait
    if (!waiting) return
    authWait = undefined
    clearInterval(waiting.ticker)
    waiting.removeInput()
    waiting.removeAbort()
    waiting.loader.dispose()
    scrollback.removeChild(waiting.loader)
    scrollback.removeChild(waiting.hint)
    tui.setFocus(editor)
    tui.requestRender()
  }
  const showStatus: DeviceGrantPresentation['showStatus'] = (status, message) => {
    if (status !== 'waiting') {
      clearAuthWait()
      appendText(tui, scrollback, formatStatus(status, message))
      return
    }
    if (authWait) return
    const startedAt = Date.now()
    const updateMessage = (): string => `${message ?? 'Waiting for approval…'} ${dim(elapsedClock(startedAt))}`
    const loader = new CancellableLoader(tui, boltYellow, (text) => text, updateMessage(), {
      frames: sparkFrames(),
      intervalMs: 600,
    })
    const hint = new Text(`${amber('enter')}${dim(' reopen browser  ·  ')}${amber('esc')}${dim(' cancel')}`)
    scrollback.addChild(loader)
    scrollback.addChild(hint)
    const ticker = setInterval(() => loader.setMessage(updateMessage()), 1_000)
    ticker.unref()
    const removeInput = tui.addInputListener((data) => {
      if (!matchesKey(data, Key.enter) || browserUrl === undefined) return undefined
      void openQuietly(opener, browserUrl)
      return { consume: true }
    })
    const waiting: AuthWaitState = { loader, hint, ticker, removeInput, removeAbort: () => {} }
    authWait = waiting
    waiting.removeAbort = bindAbort(activeSignal(), clearAuthWait)
    loader.onAbort = clearAuthWait
    tui.requestRender()
  }

  return {
    choose: (title, items) =>
      title === 'Models' && activeModel
        ? chooseModelsOverlay(tui, items, activeModel(), activeSignal())
        : chooseTui(tui, scrollback, editor, title, items, activeSignal()),
    readText: (prompt) => readTuiText(tui, scrollback, editor, prompt, activeSignal()),
    readSecret: (prompt) => readTuiSecret(tui, scrollback, editor, prompt, activeSignal()),
    write: (text) => appendText(tui, scrollback, text),
    showVerification: (value) => appendText(tui, scrollback, formatVerification(value)),
    showStatus,
    promptToOpenBrowser: async (url) => {
      browserUrl = url
      if ((await readTuiText(tui, scrollback, editor, authBrowserPrompt, activeSignal())) === null) return
      await openQuietly(opener, url)
      appendText(tui, scrollback, `${green(symbols.ok)} ${dim('browser opened')}`)
    },
  }
}
