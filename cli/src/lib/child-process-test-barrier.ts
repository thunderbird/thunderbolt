/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const barrierByte = 82

/** File URL used by eval-based child processes to import the release barrier. */
export const childProcessBarrierModuleUrl = import.meta.url

/** Signals readiness from a child process and blocks until its parent releases it. */
export const waitForParentRelease = async (): Promise<void> => {
  process.stdout.write(Uint8Array.of(barrierByte))
  const reader = Bun.stdin.stream().getReader()
  try {
    const release = await reader.read()
    if (release.done) throw new Error('child-process barrier closed before release')
  } finally {
    reader.releaseLock()
  }
}

/** Starts a child process and returns after its stdout readiness byte arrives. */
export const spawnBarrierChild = async (script: string, args: readonly string[]) => {
  const child = Bun.spawn([process.execPath, '--eval', script, ...args], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const reader = child.stdout.getReader()
  /** Decodes the remaining child stdout chunks after the readiness byte. */
  const readRemainingText = async (
    decoder: TextDecoder = new TextDecoder(),
    contents: string = '',
  ): Promise<string> => {
    const chunk = await reader.read()
    if (chunk.done) return `${contents}${decoder.decode()}`
    return readRemainingText(decoder, `${contents}${decoder.decode(chunk.value, { stream: true })}`)
  }
  const ready = await reader.read()
  if (ready.done || ready.value.length !== 1 || ready.value[0] !== barrierByte) {
    reader.releaseLock()
    child.kill()
    throw new Error('child process exited before reaching its barrier')
  }

  return {
    release: (): void => {
      child.stdin.write(Uint8Array.of(barrierByte))
      child.stdin.end()
    },
    result: async (): Promise<string> => {
      const output = await readRemainingText()
      reader.releaseLock()
      const exitCode = await child.exited
      if (exitCode !== 0) throw new Error(`child process exited with status ${exitCode}`)
      return output.trim()
    },
  }
}
