/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type { EditorTheme, SelectListTheme } from '@earendil-works/pi-tui'
import { CancellableLoader, Container, Editor, Input, SelectList, TUI } from '@earendil-works/pi-tui'
import { runProviderManager } from '../provider-runtime/manager.ts'
import type { ProviderCommand, ProviderRuntime, ProviderSnapshot } from '../provider-runtime/types.ts'
import {
  authBrowserPrompt,
  createPlainProviderManagerIO,
  createTuiProviderManagerIO,
} from './provider-manager.ts'
import { MemoryTerminal } from './test-fixtures.ts'
import type { TerminalIO } from './prompt.ts'
import { buildTuiPermissionPrompt } from './tui.ts'
import { symbols } from './theme.ts'

const snapshot: ProviderSnapshot = {
  revision: 0,
  activeProviderId: 'byok-work',
  thunderbolt: {
    status: 'not authenticated',
    defaultModelId: 'managed-default',
    models: [{ id: 'managed-default', label: 'Managed default' }],
  },
  providers: [
    {
      id: 'byok-work',
      label: 'Work',
      provider: 'openai',
      status: 'authenticated',
      defaultModel: 'gpt-test',
      models: [{ id: 'gpt-test', label: 'GPT test' }],
    },
  ],
}

/** Builds a runtime that drives every device-grant presentation operation. */
const presentationRuntime = (): ProviderRuntime => ({
  snapshot: () => snapshot,
  prepare: async () => {
    throw new Error('prepare is not used by presentation tests')
  },
  manage: async (command: ProviderCommand) => {
    if (command.type === 'login') {
      command.presentation.showVerification({
        verificationUrl: 'https://accounts.example/activate?from=cli',
        userCode: 'ABCD-EFGH',
        qrBlock: '██ QR ██',
      })
      command.presentation.showStatus('waiting', 'Waiting for approval…')
      command.presentation.showStatus('success', 'Login successful.')
    }
    if (command.type === 'logout') command.presentation.showStatus('error', 'Remote logout failed.')
    return snapshot
  },
})

const identity = (text: string): string => text
const selectTheme: SelectListTheme = {
  selectedPrefix: identity,
  selectedText: identity,
  description: identity,
  scrollInfo: identity,
  noMatch: identity,
}
const editorTheme: EditorTheme = { borderColor: identity, selectList: selectTheme }

afterEach(() => {
  mock.restore()
})

describe('plain provider-manager IO', () => {
  test('renders exact device verification, QR, waiting, success, and error states through the supplied terminal', async () => {
    const writes: string[] = []
    const terminal: TerminalIO = {
      isTTY: false,
      signal: new AbortController().signal,
      readLine: async () => null,
      readSecret: async () => null,
      write: (text) => writes.push(text),
      ask: async () => 'deny',
      close: () => {},
    }
    const io = createPlainProviderManagerIO(terminal)
    const runtime = presentationRuntime()

    await runProviderManager(io, runtime, 'login')
    await runProviderManager(io, runtime, 'logout')

    expect(writes.join('')).toContain('https://accounts.example/activate?from=cli')
    expect(writes.join('')).toContain('ABCD-EFGH')
    expect(writes.join('')).toContain('██ QR ██')
    expect(writes.join('')).toContain(`${symbols.spark} Waiting for approval…`)
    expect(writes.join('')).toContain(`${symbols.ok} Login successful.`)
    expect(writes.join('')).toContain(`${symbols.fail} Remote logout failed.`)
  })

  test('uses numbered choices, normal text input, and the terminal hidden-input seam', async () => {
    const lines = ['2', 'profile name']
    const secrets = ['private-key']
    const prompts: string[] = []
    const terminal: TerminalIO = {
      isTTY: false,
      signal: new AbortController().signal,
      readLine: async (prompt) => {
        prompts.push(prompt)
        return lines.shift() ?? null
      },
      readSecret: async (prompt) => {
        prompts.push(prompt)
        return secrets.shift() ?? null
      },
      write: () => {},
      ask: async () => 'deny',
      close: () => {},
    }
    const io = createPlainProviderManagerIO(terminal)

    await expect(
      io.choose('Providers', [
        { id: 'one', label: 'One' },
        { id: 'two', label: 'Two' },
      ]),
    ).resolves.toBe('two')
    await expect(io.readText('Profile: ')).resolves.toBe('profile name')
    await expect(io.readSecret('API key: ')).resolves.toBe('private-key')
    expect(prompts).toEqual(['Choice [1-2]: ', 'Profile: ', 'API key: '])
  })

  test('prompts a TTY with the exact browser copy and opens the exact complete URL', async () => {
    const prompts: string[] = []
    const opened: string[] = []
    const terminal: TerminalIO = {
      isTTY: true,
      signal: new AbortController().signal,
      readLine: async (prompt) => {
        prompts.push(prompt)
        return ''
      },
      readSecret: async () => null,
      write: () => {},
      ask: async () => 'deny',
      close: () => {},
    }
    const io = createPlainProviderManagerIO(terminal, async (url) => {
      opened.push(url)
    })

    await io.promptToOpenBrowser?.('https://accounts.example/activate?user_code=ABCD-EFGH')

    expect(prompts).toEqual([authBrowserPrompt])
    expect(opened).toEqual(['https://accounts.example/activate?user_code=ABCD-EFGH'])
  })

  test('keeps login moving when the browser opener rejects', async () => {
    const terminal: TerminalIO = {
      isTTY: true,
      signal: new AbortController().signal,
      readLine: async () => '',
      readSecret: async () => null,
      write: () => {},
      ask: async () => 'deny',
      close: () => {},
    }
    const io = createPlainProviderManagerIO(terminal, async () => {
      throw new Error('browser unavailable')
    })

    await expect(io.promptToOpenBrowser?.('https://accounts.example/activate')).resolves.toBeUndefined()
  })

  test('keeps the printed fallback without prompting or opening when stdin is not a TTY', async () => {
    const writes: string[] = []
    let prompts = 0
    const io = createPlainProviderManagerIO(
      {
        readLine: async () => {
          prompts += 1
          return ''
        },
        readSecret: async () => null,
        write: (text) => writes.push(text),
      },
      () => {
        throw new Error('non-TTY input must not open a browser')
      },
    )

    io.showVerification({
      verificationUrl: 'https://accounts.example/activate',
      userCode: 'ABCD-EFGH',
    })
    await io.promptToOpenBrowser?.('https://accounts.example/activate?user_code=ABCD-EFGH')

    expect(writes.join('')).toContain('https://accounts.example/activate')
    expect(writes.join('')).toContain('ABCD-EFGH')
    expect(prompts).toBe(0)
    expect(io.promptToOpenBrowser).toBeUndefined()
  })

  test('neutralizes terminal controls in manager output', () => {
    const writes: string[] = []
    const io = createPlainProviderManagerIO({
      readLine: async () => null,
      readSecret: async () => null,
      write: (text) => writes.push(text),
    })

    io.write('provider\x1b[2J ready')

    expect(writes.join('')).toContain('provider ready')
    expect(writes.join('')).not.toContain('2J')
  })
})

describe('TUI provider-manager IO', () => {
  const setup = (activeSignal: () => AbortSignal | undefined = () => undefined) => {
    const terminal = new MemoryTerminal()
    const tui = new TUI(terminal)
    const scrollback = new Container()
    const editor = new Editor(tui, editorTheme)
    spyOn(tui, 'requestRender').mockImplementation(() => {})
    return { tui, scrollback, editor, io: createTuiProviderManagerIO(tui, scrollback, editor, activeSignal) }
  }

  test('renders every device-grant state as scrollback components and never writes directly to stdout', async () => {
    const stdoutWrite = spyOn(process.stdout, 'write').mockImplementation(() => true)
    const { scrollback, io } = setup()
    const runtime = presentationRuntime()

    const login = runProviderManager(io, runtime, 'login')
    await Promise.resolve()
    await Promise.resolve()
    const modelList = scrollback.children.find((child): child is SelectList => child instanceof SelectList)
    expect(modelList).toBeDefined()
    modelList!.onSelect?.(modelList!.getSelectedItem()!)
    await login
    await runProviderManager(io, runtime, 'logout')

    const rendered = scrollback.render(120).join('\n')
    expect(rendered).toContain('https://accounts.example/activate?from=cli')
    expect(rendered).toContain('ABCD-EFGH')
    expect(rendered).toContain('██ QR ██')
    expect(rendered).toContain(`${symbols.ok} Login successful.`)
    expect(rendered).toContain(`${symbols.fail} Remote logout failed.`)
    expect(stdoutWrite).not.toHaveBeenCalled()
  })

  test('resolves a focused SelectList choice and restores focus to the editor', async () => {
    const { scrollback, editor, io } = setup()

    const choice = io.choose('Providers', [
      { id: 'one', label: 'One' },
      { id: 'two', label: 'Two' },
    ])
    const list = scrollback.children.find((child): child is SelectList => child instanceof SelectList)
    expect(list).toBeDefined()
    list!.setSelectedIndex(1)
    list!.onSelect?.(list!.getSelectedItem()!)

    await expect(choice).resolves.toBe('two')
    expect(editor.focused).toBe(true)
    expect(scrollback.children).not.toContain(list!)
  })

  test('opens and closes model choices through a bottom-center overlay', async () => {
    const { tui, scrollback, editor } = setup()
    const showOverlay = spyOn(tui, 'showOverlay')
    tui.setFocus(editor)
    const io = createTuiProviderManagerIO(tui, scrollback, editor, () => undefined, () => 'one')

    const choice = io.choose('Models', [
      { id: 'one', label: 'One' },
      { id: 'two', label: 'Two' },
    ])
    const overlay = showOverlay.mock.calls[0]
    expect(overlay?.[1]).toMatchObject({ anchor: 'bottom-center', width: '70%' })
    const list = (overlay?.[0] as { children?: unknown[] } | undefined)?.children?.find(
      (child): child is SelectList => child instanceof SelectList,
    )
    expect(list).toBeDefined()
    list!.onCancel?.()

    await expect(choice).resolves.toBeNull()
    expect(tui.hasOverlay()).toBeFalse()
    expect(editor.focused).toBeTrue()
  })

  test('cancels an aborted focused SelectList and restores editor focus without persisting a selection', async () => {
    const controller = new AbortController()
    const { scrollback, editor, io } = setup(() => controller.signal)

    const choice = io.choose('Providers', [{ id: 'one', label: 'One' }])
    const list = scrollback.children.find((child): child is SelectList => child instanceof SelectList)
    controller.abort()

    await expect(choice).resolves.toBeNull()
    expect(editor.focused).toBe(true)
    expect(scrollback.children).not.toContain(list!)
  })

  test('uses the shared editor for text and a masked focused input for secrets', async () => {
    const { scrollback, editor, io } = setup()
    const previousSubmit = () => {}
    editor.onSubmit = previousSubmit

    const text = io.readText('Profile: ')
    expect(editor.focused).toBe(true)
    editor.onSubmit?.('Work profile')
    await expect(text).resolves.toBe('Work profile')
    expect(editor.onSubmit).toBe(previousSubmit)

    const secret = io.readSecret('API key: ')
    const input = scrollback.children.find((child): child is Input => child instanceof Input)
    expect(input).toBeDefined()
    input!.setValue('super-secret')
    expect(input!.render(80).join('\n')).not.toContain('super-secret')
    input!.onSubmit?.('super-secret')

    await expect(secret).resolves.toBe('super-secret')
    expect(editor.focused).toBe(true)
  })

  test('uses the existing editor prompt before opening the exact complete URL', async () => {
    const terminal = new MemoryTerminal()
    const tui = new TUI(terminal)
    const scrollback = new Container()
    const editor = new Editor(tui, editorTheme)
    const opened: string[] = []
    spyOn(tui, 'requestRender').mockImplementation(() => {})
    const io = createTuiProviderManagerIO(tui, scrollback, editor, () => undefined, undefined, async (url) => {
      opened.push(url)
    })

    const prompt = io.promptToOpenBrowser?.('https://accounts.example/activate?user_code=ABCD-EFGH')
    expect(scrollback.render(120).join('\n')).toContain(authBrowserPrompt)
    editor.onSubmit?.('')
    await prompt

    expect(opened).toEqual(['https://accounts.example/activate?user_code=ABCD-EFGH'])
  })

  test('keeps a cancellable auth loader visible while Enter reopens the browser', async () => {
    const terminal = new MemoryTerminal()
    const tui = new TUI(terminal)
    const scrollback = new Container()
    const editor = new Editor(tui, editorTheme)
    const opened: string[] = []
    const listeners: Parameters<TUI['addInputListener']>[0][] = []
    spyOn(tui, 'requestRender').mockImplementation(() => {})
    spyOn(tui, 'addInputListener').mockImplementation((listener) => {
      listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    })
    const io = createTuiProviderManagerIO(tui, scrollback, editor, () => undefined, undefined, async (url) => {
      opened.push(url)
    })

    const prompt = io.promptToOpenBrowser?.('https://accounts.example/activate?user_code=ABCD-EFGH')
    editor.onSubmit?.('')
    await prompt
    io.showStatus('waiting', 'Waiting for approval…')

    expect(scrollback.children.some((child) => child instanceof CancellableLoader)).toBeTrue()
    listeners.at(-1)?.('\r')
    await Promise.resolve()
    expect(opened).toHaveLength(2)

    io.showStatus('success', 'Login successful.')
    expect(scrollback.children.some((child) => child instanceof CancellableLoader)).toBeFalse()
  })

  test('cancels an aborted secret prompt and removes its focused input', async () => {
    const controller = new AbortController()
    const { scrollback, editor, io } = setup(() => controller.signal)

    const secret = io.readSecret('API key: ')
    const input = scrollback.children.find((child): child is Input => child instanceof Input)
    controller.abort()

    await expect(secret).resolves.toBeNull()
    expect(editor.focused).toBe(true)
    expect(scrollback.children).not.toContain(input!)
  })

  test('teardown cancels a pending permission prompt as deny and restores editor focus', async () => {
    const { tui, scrollback, editor } = setup()
    const controller = new AbortController()
    const ask = buildTuiPermissionPrompt(tui, scrollback, editor, () => controller.signal)

    const decision = ask({ toolName: 'bash', summary: 'echo pending' })
    const list = scrollback.children.find((child): child is SelectList => child instanceof SelectList)
    controller.abort()

    await expect(decision).resolves.toBe('deny')
    expect(editor.focused).toBe(true)
    expect(scrollback.children).not.toContain(list!)
  })

  test('neutralizes terminal controls before adding manager output to scrollback', () => {
    const { scrollback, io } = setup()

    io.write('provider\x1b[2J ready')

    const rendered = scrollback.render(120).join('\n')
    expect(rendered).toContain('provider ready')
    expect(rendered).not.toContain('2J')
  })
})
