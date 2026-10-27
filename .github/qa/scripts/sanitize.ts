/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Imports nothing, so filing, the fix step, the report, the Maestro gate and the replay can all use it without an
// import cycle.

export const secretPattern =
  /\bsk-[\w-]{8,}|lin_(api|oauth)_\w+|gh[pousr]_\w+|github_pat_\w+|eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*|xox[bp]-[\w-]+/

const secrets = new RegExp(secretPattern.source, 'g')

const keepUrl = (url: string, runUrl?: string): boolean => {
  if (runUrl && url.startsWith(runUrl)) return true
  try {
    // localhost stays so repro specs remain readable; it points nowhere outside the runner.
    return ['uploads.linear.app', 'localhost', '127.0.0.1'].includes(new URL(url).hostname)
  } catch {
    return false
  }
}

export const sanitize = (text: string, max: number, runUrl?: string): string =>
  text
    .replace(/!\[[^\]]*\]\([^)]*\)|!\[[^\]]*\]\[[^\]]*\]|<img[^>]*>/gi, '[image removed]')
    .replace(/https?:\/\/[^\s)>\]"'`]+/g, (url) => (keepUrl(url, runUrl) ? url : '[link removed]'))
    // The ticket body puts this text inside a code fence, and it must not close it.
    .replaceAll('```', "'''")
    .slice(0, max)

/** The replay compares its own log lines in this form, because the explorer quotes them as evidence. */
export const cleanLogLine = (line: string) => sanitize(line.replace(secrets, '[secret removed]'), Infinity)
