import { Command } from '@tauri-apps/plugin-shell'
import type { SubprocessHandle, SubprocessSpawner } from './stdio-stream'

/**
 * Create a SubprocessSpawner backed by Tauri's shell plugin.
 * Only works in desktop/mobile Tauri environments.
 */
export const createTauriSpawner = (): SubprocessSpawner => ({
  spawn: async (command: string, args: string[]): Promise<SubprocessHandle> => {
    const cmd = Command.create(command, args)

    const child = await cmd.spawn()

    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()

        cmd.stdout.on('data', (data) => {
          if (typeof data === 'string') {
            controller.enqueue(encoder.encode(data))
          } else {
            controller.enqueue(data)
          }
        })

        cmd.on('close', () => {
          try {
            controller.close()
          } catch {
            // Already closed
          }
        })

        cmd.on('error', (error) => {
          try {
            controller.error(new Error(String(error)))
          } catch {
            // Already closed
          }
        })
      },
    })

    // Bridge WritableStream to Tauri's child.write
    const stdin = new WritableStream<Uint8Array>({
      write(chunk) {
        return child.write(chunk)
      },
    })

    let exitCallback: ((code: number | null) => void) | null = null

    cmd.on('close', (data) => {
      exitCallback?.(data.code)
    })

    return {
      stdin,
      stdout,
      kill: () => child.kill(),
      onExit: (callback) => {
        exitCallback = callback
      },
    }
  },

  which: async (command: string): Promise<string | null> => {
    try {
      const cmd = Command.create('which', [command])
      const output = await cmd.execute()
      return output.code === 0 ? output.stdout.trim() : null
    } catch {
      return null
    }
  },
})
