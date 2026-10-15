/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { err, ok, FileError, ExecutionError, type Result, type ShellExecOptions } from '@earendil-works/pi-agent-core'
import type { CodingEnvironment } from './execution-environment.ts'

/** Injected desktop IPC keeps the shared engine independent of Tauri. */
export type NativeInvoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>
type ShellOutput = { stdout: string; stderr: string; exitCode: number; failure?: 'aborted' | 'timeout' }

/** Real filesystem and shell operations, available only through desktop IPC. */
export class NativeExecutionEnv implements CodingEnvironment {
  constructor(
    readonly cwd: string,
    private readonly invoke: NativeInvoke,
  ) {}

  private async file<T>(
    operation: string,
    path?: string,
    extra: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<Result<T, FileError>> {
    if (signal?.aborted) {
      return err(new FileError('unknown', 'aborted', path ?? this.cwd))
    }
    try {
      return ok(await this.invoke<T>('agent_fs', { cwd: this.cwd, operation, path, ...extra }))
    } catch (error) {
      return err(new FileError('unknown', String(error), path ?? this.cwd))
    }
  }

  absolutePath(path: string) {
    return this.file<string>('resolve', path)
  }

  async readBinaryFile(path: string, signal?: AbortSignal): Promise<Result<Uint8Array, FileError>> {
    const result = await this.file<number[]>('read', path, {}, signal)
    return result.ok ? ok(new Uint8Array(result.value)) : result
  }

  writeFile(path: string, content: string | Uint8Array, signal?: AbortSignal) {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
    return this.file<void>('write', path, { content: Array.from(bytes) }, signal)
  }

  createTempFile(options?: { prefix?: string; suffix?: string }) {
    return this.file<string>('temp', undefined, { prefix: options?.prefix, suffix: options?.suffix })
  }

  async exec(command: string, options?: ShellExecOptions): Promise<Result<ShellOutput, ExecutionError>> {
    if (options?.abortSignal?.aborted) {
      return err(new ExecutionError('aborted', 'aborted'))
    }
    const id = crypto.randomUUID()
    const cancel = () => {
      void this.invoke('agent_cancel_command', { id }).catch(console.error)
    }
    try {
      // Register first, so Stop cannot race the native process being spawned.
      await this.invoke('agent_prepare_command', { id })
      options?.abortSignal?.addEventListener('abort', cancel, { once: true })
      if (options?.abortSignal?.aborted) {
        return err(new ExecutionError('aborted', 'aborted'))
      }
      const output = await this.invoke<ShellOutput>('agent_exec', {
        id,
        command,
        cwd: options?.cwd ?? this.cwd,
        env: options?.env ?? {},
        timeout: options?.timeout ?? 120,
      })
      options?.onStdout?.(output.stdout)
      options?.onStderr?.(output.stderr)
      if (output.failure) {
        return err(
          new ExecutionError(
            output.failure,
            output.failure === 'timeout' ? `timeout:${options?.timeout ?? 120}` : 'aborted',
          ),
        )
      }
      return ok(output)
    } catch (error) {
      return err(new ExecutionError('unknown', String(error)))
    } finally {
      options?.abortSignal?.removeEventListener('abort', cancel)
      await this.invoke('agent_forget_command', { id }).catch(console.error)
    }
  }
}
