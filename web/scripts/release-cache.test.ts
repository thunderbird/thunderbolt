/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Run explicitly with `bun run test:release-cache`; requires Docker.
import { expect, test } from 'bun:test'
import { fetch } from 'bun'
import { chmod, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Run the isolated nginx fixture and surface container failures as test failures. */
const docker = (...args: string[]) => {
  const result = Bun.spawnSync(['docker', ...args])
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

test('nginx shares release lookups, refreshes expired metadata, and survives upstream outages', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'thunderbolt-release-cache-'))
  await chmod(directory, 0o755)
  const snapshot = { tag_name: 'bundled', draft: false, prerelease: false, assets: [] }
  await writeFile(join(directory, 'release.json'), JSON.stringify(snapshot))
  const production = await readFile(new URL('../../deploy/config/marketing-nginx.conf', import.meta.url), 'utf8')
  const config = production
    .replace('https://api.github.com/repos/thunderbird/thunderbolt/releases/latest?', 'http://127.0.0.1:8081/')
    .replace('root /usr/share/nginx/html;', `root /fixtures;`)
    .replace('try_files /downloads/release.json =503;', 'try_files /release.json =503;')
    .replace('proxy_cache_valid 200 5m;', 'proxy_cache_valid 200 1s;')
  await writeFile(
    join(directory, 'default.conf'),
    `${config}\nserver {
    listen 8081;
    root /fixtures;
    location / {
      add_header Cache-Control "no-cache";
      add_header Set-Cookie "upstream=must-not-leak";
      try_files /upstream.json =503;
    }
  }`,
  )
  const container = docker(
    'run',
    '--rm',
    '-d',
    '-p',
    '127.0.0.1::8080',
    '-v',
    `${directory}:/fixtures:ro`,
    '-v',
    `${directory}/default.conf:/etc/nginx/conf.d/default.conf:ro`,
    'nginxinc/nginx-unprivileged:alpine',
  )
  try {
    const port = docker('port', container, '8080/tcp').split(':').at(-1)
    const url = `http://127.0.0.1:${port}/downloads/release.json`
    const response = async () => fetch(url)
    // Container startup is asynchronous; wait for its HTTP listener.
    for (let attempt = 0; ; attempt++) {
      try {
        await response()
        break
      } catch (error) {
        if (attempt === 40) throw error
        await Bun.sleep(100)
      }
    }
    expect(await (await response()).json()).toEqual(snapshot)
    await writeFile(join(directory, 'upstream.json'), JSON.stringify({ ...snapshot, tag_name: 'v1' }))
    const visitors = await Promise.all(
      Array.from({ length: 8 }, () => fetch(url, { headers: { Cookie: 'private=visitor' } })),
    )
    expect(visitors.filter((item) => item.headers.get('x-release-cache') === 'MISS')).toHaveLength(1)
    expect(visitors.filter((item) => item.headers.get('x-release-cache') === 'HIT')).toHaveLength(7)
    const first = visitors.find((item) => item.headers.get('x-release-cache') === 'MISS')!
    expect(first.headers.get('x-release-cache')).toBe('MISS')
    expect(first.headers.get('set-cookie')).toBeNull()
    expect((await first.json()).tag_name).toBe('v1')
    const second = await fetch(`${url}?visitor=another`, { headers: { Cookie: 'visitor=private' } })
    expect(second.headers.get('x-release-cache')).toBe('HIT')
    await writeFile(join(directory, 'upstream.json'), JSON.stringify({ ...snapshot, tag_name: 'v2' }))
    await Bun.sleep(2100)
    expect((await (await response()).json()).tag_name).toBe('v1')
    for (let attempt = 0; ; attempt++) {
      if ((await (await response()).json()).tag_name === 'v2') break
      if (attempt === 30) throw new Error('Cache did not refresh')
      await Bun.sleep(100)
    }
    await unlink(join(directory, 'upstream.json'))
    await Bun.sleep(2100)
    expect((await (await response()).json()).tag_name).toBe('v2')
    await Bun.sleep(200)
    expect((await (await response()).json()).tag_name).toBe('v2')
  } finally {
    docker('rm', '-f', container)
    await rm(directory, { recursive: true, force: true })
  }
}, 20000)
