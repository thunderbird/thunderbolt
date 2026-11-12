/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { err, ok, FileError, ExecutionError, type Result, type ShellExecOptions } from '@earendil-works/pi-agent-core'
import type { CodingEnvironment } from './execution-environment.ts'
import type { NativeInvoke } from './native-execution-env.ts'
import { invokeSshRequest, type SshConnection, type SshRequest } from './ssh-transport.ts'

type ShellOutput = { stdout: string; stderr: string; exitCode: number; failure?: 'aborted' | 'timeout' }

/** The same coding tools backed by one saved SSH destination, never the local filesystem. */
export class SshExecutionEnv implements CodingEnvironment {
  readonly defaultCommandTimeout = 120
  readonly maximumCommandTimeout = 3600

  constructor(
    readonly cwd: string,
    private readonly connection: SshConnection,
    private readonly invoke: NativeInvoke,
    private readonly owner: string = crypto.randomUUID(),
  ) {}

  private request<T>(request: Omit<SshRequest, 'cwd' | 'owner'> & { cwd?: string }, signal?: AbortSignal) {
    return invokeSshRequest<T>(this.invoke, this.connection, { cwd: this.cwd, owner: this.owner, ...request }, signal)
  }

  private async file<T>(
    request: Omit<SshRequest, 'cwd' | 'owner'>,
    signal?: AbortSignal,
  ): Promise<Result<T, FileError>> {
    try {
      return ok(await this.request<T>(request, signal))
    } catch (error) {
      return err(new FileError(signal?.aborted ? 'aborted' : 'unknown', String(error), request.path ?? this.cwd))
    }
  }

  absolutePath(path: string) {
    return this.file<string>({ operation: 'resolve', path })
  }

  async readBinaryFile(path: string, signal?: AbortSignal): Promise<Result<Uint8Array, FileError>> {
    const result = await this.file<number[]>({ operation: 'read', path }, signal)
    return result.ok ? ok(new Uint8Array(result.value)) : result
  }

  writeFile(path: string, content: string | Uint8Array, signal?: AbortSignal) {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
    return this.file<void>({ operation: 'write', path, content: Array.from(bytes) }, signal)
  }

  restoreFile(path: string, content: string | Uint8Array, signal?: AbortSignal) {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
    return this.file<void>({ operation: 'restore', path, content: Array.from(bytes) }, signal)
  }

  createTempFile(options?: { prefix?: string; suffix?: string }) {
    return this.file<string>({ operation: 'temp', ...options })
  }

  /** Remove only remote output files registered to this adapter owner. */
  async cleanup(): Promise<void> {
    await this.request({ operation: 'cleanup' })
  }

  async exec(command: string, options?: ShellExecOptions): Promise<Result<ShellOutput, ExecutionError>> {
    try {
      const output = await this.request<ShellOutput>(
        {
          operation: 'exec',
          command,
          cwd: options?.cwd ?? this.cwd,
          env: options?.env ?? {},
          timeout: options?.timeout ?? this.defaultCommandTimeout,
        },
        options?.abortSignal,
      )
      options?.onStdout?.(output.stdout)
      options?.onStderr?.(output.stderr)
      if (output.failure) {
        return err(
          new ExecutionError(
            output.failure,
            output.failure === 'timeout' ? `timeout:${options?.timeout ?? this.defaultCommandTimeout}` : 'aborted',
          ),
        )
      }
      return ok(output)
    } catch (error) {
      return err(new ExecutionError(options?.abortSignal?.aborted ? 'aborted' : 'unknown', String(error)))
    }
  }
}
