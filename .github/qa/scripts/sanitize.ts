/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Text cleaning shared by filing, the fix step, the report, the Maestro gate and the replay. It imports nothing, so
// any of them can use it without an import cycle.

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

/** Model-written text made safe for a ticket: no images, no foreign URLs, no fence breakout, capped. */
export const sanitize = (text: string, max: number, runUrl?: string): string =>
  text
    .replace(/!\[[^\]]*\]\([^)]*\)|!\[[^\]]*\]\[[^\]]*\]|<img[^>]*>/gi, '[image removed]')
    .replace(/https?:\/\/[^\s)>\]"'`]+/g, (url) => (keepUrl(url, runUrl) ? url : '[link removed]'))
    .replaceAll('```', "'''")
    .slice(0, max)

/**
 * A log line as the native explorer sees it: secrets hidden, foreign links removed. The replay compares its own log
 * lines in this form, because the explorer quotes them as evidence. The gate also caps each line at 500 characters.
 */
export const cleanLogLine = (line: string) => sanitize(line.replace(secrets, '[secret removed]'), Infinity)
