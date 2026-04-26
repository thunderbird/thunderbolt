import { Command } from '@tauri-apps/plugin-shell'
import type { SubprocessHandle, SubprocessSpawner } from './stdio-stream'

/**
 * Create a SubprocessSpawner backed by Tauri's shell plugin.
 * Only works in desktop/mobile Tauri environments.
 */
export const createTauriSpawner = (): SubprocessSpawner => ({
  spawn: async (command: string, args: string[]): Promise<SubprocessHandle> => {
    let cmd: ReturnType<typeof Command.create>
    try {
      cmd = Command.create(command, args)
    } catch (err) {
      throw new Error(`Cannot create command "${command}": ${err instanceof Error ? err.message : JSON.stringify(err)}`)
    }

    let child: Awaited<ReturnType<ReturnType<typeof Command.create>['spawn']>>
    try {
      child = await cmd.spawn()
    } catch (err) {
      throw new Error(`Failed to spawn "${command}": ${err instanceof Error ? err.message : JSON.stringify(err)}`)
    }

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
            controller.error(new Error(typeof error === 'string' ? error : JSON.stringify(error)))
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
    let stderrCallback: ((data: string) => void) | null = null

    cmd.on('close', (data) => {
      exitCallback?.(data.code)
    })

    cmd.stderr.on('data', (data) => {
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
      stderrCallback?.(text)
    })

    return {
      stdin,
      stdout,
      kill: () => child.kill(),
      onExit: (callback) => {
        exitCallback = callback
      },
      onStderr: (callback) => {
        stderrCallback = callback
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
