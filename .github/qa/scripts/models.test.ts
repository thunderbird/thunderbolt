/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultModels } from '../../../shared/defaults/models'

const qaDir = join(import.meta.dir, '..')
const modelName = /^(Opus|Sonnet|Haiku|GLM|DeepSeek|Kimi|Qwen|GPT)\b/

it('every model name the charters, prompt and functions quote is a shipped default model', async () => {
  const charters = (await readdir(join(qaDir, 'charters'))).map((file) => join('charters', file))
  const quoted = new Set<string>()
  for (const file of [...charters, 'prompt.md', 'functions.json']) {
    const text = await readFile(join(qaDir, file), 'utf8')
    for (const [, name] of text.matchAll(/\\?["'`]([^"'`\\]+)\\?["'`]/g)) {
      if (modelName.test(name)) quoted.add(name)
    }
  }

  expect(quoted.size).toBeGreaterThan(0)
  expect([...quoted].filter((name) => !defaultModels.some((model) => model.name === name))).toEqual([])
})
