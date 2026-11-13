/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { $, fetch } from 'bun'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { docker, startNginx, unreachableDns } from './nginx-container'

// Every test boots its own container, and some wait for a cached release to expire.
setDefaultTimeout(20_000)

/** Answers GitHub chooses to give, and would give again at once: its rate limits, and no such release. */
const refusals = ['403', '404', '429'] as const
/** Failures that say nothing about the next lookup: server errors, and a connection closed without an answer. */
const outages = ['500', '502', '503', '504', 'dropped-connection'] as const
const failures = [...refusals, ...outages]
type GitHubAnswer = object | (typeof failures)[number]

/**
 * A stand-in for the GitHub API, served by the same nginx on port 8081, and on 8443 over TLS
 * with a certificate that no authority signed. It answers with headers that would change how
 * the release is cached, or how browsers treat the site, if nginx acted on them or passed them
 * on. It reports what reached it in `X-Seen-*` headers, and logs every request so that a test
 * can count them.
 */
const gitHubStandIn = `
server {
    listen 8081;
    listen 8443 ssl;
    ssl_certificate /github-tls/certificate.pem;
    ssl_certificate_key /github-tls/key.pem;
    root /github;
    default_type application/json;
    access_log /github/requests.log;

    location / {
        add_header X-Seen-Uri $request_uri always;
        add_header X-Seen-Client "$http_user_agent accepting $http_accept" always;
        add_header X-Seen-Credentials "cookie=$http_cookie authorization=$http_authorization" always;
        add_header Cache-Control "public, max-age=60, s-maxage=60" always;
        add_header Expires "Thu, 01 Jan 1970 00:00:00 GMT" always;
        add_header Set-Cookie "github=must-not-leak" always;
        add_header Vary "Accept, Accept-Encoding, X-Requested-With" always;
        add_header Strict-Transport-Security "max-age=31536000; includeSubdomains; preload" always;

        # A test chooses a failure by creating a file named after it. nginx answers 444 by
        # closing the connection.
${failures.map((failure) => `        if (-f /github/${failure}) { return ${failure === 'dropped-connection' ? 444 : failure}; }`).join('\n')}
        # A body over 64 KB takes a second to send, which lets a test make lookups overlap.
        limit_rate 64k;
        try_files /release.json =503;
    }
}
`

/** Swap one directive of a config. A replacement that silently matched nothing would test the wrong server. */
const replaceDirective = (config: string, directive: string, replacement: string) => {
  if (!config.includes(directive)) throw new Error(`The marketing nginx config no longer contains "${directive}"`)
  return config.replace(directive, replacement)
}

const productionConfig = readFileSync(join(import.meta.dir, 'marketing-nginx.conf.template'), 'utf8')
/** The production config, looking the release up at the stand-in instead of GitHub. */
const standInConfig =
  replaceDirective(
    productionConfig,
    'set $release_upstream https://api.github.com;',
    'set $release_upstream http://127.0.0.1:8081;',
  ) + gitHubStandIn
/** The stand-in config, keeping a release for a second rather than five minutes. */
const shortLivedConfig = replaceDirective(standInConfig, 'proxy_cache_valid 200 5m;', 'proxy_cache_valid 200 1s;')
/** The stand-in config, remembering a failed lookup for a second rather than a minute. */
const forgetfulConfig = replaceDirective(standInConfig, 'proxy_cache_valid any 1m;', 'proxy_cache_valid any 1s;')
/** The stand-in reached over TLS, where its certificate cannot be verified. */
const unverifiableConfig = replaceDirective(
  standInConfig,
  'set $release_upstream http://127.0.0.1:8081;',
  'set $release_upstream https://127.0.0.1:8443;',
)
/** nginx compares whole seconds, so a release kept for one second can be served for almost two. */
const shortLifetimeMs = 2_100

const releasePath = '/repos/thunderbird/thunderbolt/releases/latest'
/** GitHub's description of a release, cut down to what tells two apart. */
const release = (tag: string) => ({ tag_name: tag, body: `Release notes for ${tag}` })
const buildRelease = release('the-build')

const tlsDirectory = mkdtempSync(join(tmpdir(), 'thunderbolt-marketing-nginx-tls-'))
const containers: string[] = []
const directories: string[] = []

beforeAll(async () => {
  const [key, certificate] = ['key.pem', 'certificate.pem'].map((name) => join(tlsDirectory, name))
  await $`openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=api.github.com -keyout ${key} -out ${certificate}`.quiet()
  // nginx runs as a different UID on Linux; mkdtemp and openssl default to owner-only access.
  chmodSync(tlsDirectory, 0o755)
  chmodSync(key, 0o644)
})

afterAll(() => rmSync(tlsDirectory, { recursive: true, force: true }))

afterEach(() => {
  try {
    containers.splice(0).forEach((name) => docker('rm', '--force', name))
  } finally {
    directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
  }
})

/**
 * Serve a site holding a home page, a 404 page and the build's copy of the release. The stand-in for
 * GitHub answers 503 until a test gives it something else to say.
 */
const startSite = async (config: string) => {
  const directory = mkdtempSync(join(tmpdir(), 'thunderbolt-marketing-nginx-'))
  directories.push(directory)
  // nginx runs as a different UID on Linux; mkdtemp defaults to owner-only access.
  chmodSync(directory, 0o755)
  const [site, gitHub, configFile] = ['site', 'github', 'default.conf.template'].map((name) => join(directory, name))
  mkdirSync(join(site, 'downloads'), { recursive: true })
  writeFileSync(join(site, 'index.html'), '<!doctype html><title>Home</title>')
  writeFileSync(join(site, '404.html'), '<!doctype html><title>Not found</title>')
  writeFileSync(join(site, 'downloads', 'release.json'), JSON.stringify(buildRelease))
  mkdirSync(gitHub)
  // The stand-in writes its request log here.
  chmodSync(gitHub, 0o777)
  writeFileSync(configFile, config)

  const name = `thunderbolt-marketing-nginx-test-${process.pid}-${directories.length}`
  containers.push(name)
  const origin = await startNginx(name, [
    '--volume',
    `${site}:/usr/share/nginx/html:ro`,
    '--volume',
    `${gitHub}:/github`,
    '--volume',
    `${tlsDirectory}:/github-tls:ro`,
    '--volume',
    `${configFile}:/etc/nginx/templates/default.conf.template:ro`,
  ])
  const requestLog = 'requests.log'

  return {
    origin,
    /** The config nginx runs, after the image has filled in the template. */
    renderedConfig: () => docker('exec', name, 'cat', '/etc/nginx/conf.d/default.conf'),
    getRelease: (query = '', init?: RequestInit) => fetch(`${origin}/downloads/release.json${query}`, init),
    /** Have the stand-in describe a release, or fail every lookup in one way. */
    setGitHubAnswer: (answer: GitHubAnswer) => {
      readdirSync(gitHub)
        .filter((file) => file !== requestLog)
        .forEach((file) => rmSync(join(gitHub, file)))
      const [file, contents] = typeof answer === 'object' ? ['release.json', JSON.stringify(answer)] : [answer, '']
      writeFileSync(join(gitHub, file), contents)
    },
    /** nginx creates the log when it starts and ends every entry with a newline. */
    gitHubRequestCount: () => readFileSync(join(gitHub, requestLog), 'utf8').split('\n').length - 1,
  }
}

type Site = Awaited<ReturnType<typeof startSite>>

/** Ask for the release until `expected` is served: a background lookup lands a moment after its request. */
const waitForRelease = async (site: Site, expected: object) => {
  const deadline = Date.now() + 5_000
  while (true) {
    const served = await (await site.getRelease()).json()
    if (Bun.deepEquals(served, expected)) return
    if (Date.now() >= deadline) throw new Error(`Still serving ${JSON.stringify(served)}`)
    await Bun.sleep(100)
  }
}

/** What a release response tells browsers and caches, whether GitHub or the build described the release. */
const expectSiteHeaders = (response: Response) => {
  expect(response.headers.get('cache-control')).toBe('public, max-age=60')
  expect(response.headers.get('content-encoding')).toBe('gzip')
  expect(response.headers.get('vary')).toBe('Accept-Encoding')
  expect(response.headers.get('expires')).toBeNull()
  expect(response.headers.get('set-cookie')).toBeNull()
  expect(response.headers.get('strict-transport-security')).toBeNull()
}

/** Serve a site whose cache holds a `v1` release that has expired. */
const startSiteWithExpiredRelease = async () => {
  const site = await startSite(shortLivedConfig)
  site.setGitHubAnswer(release('v1'))
  expect(await (await site.getRelease()).json()).toEqual(release('v1'))
  await Bun.sleep(shortLifetimeMs)
  return site
}

describe('marketing site', () => {
  test('starts without DNS, serving its pages and the release from its build', async () => {
    const site = await startSite(productionConfig)

    expect(await (await fetch(site.origin)).text()).toContain('Home')
    const response = await site.getRelease()
    expect(response.status).toBe(200)
    expectSiteHeaders(response)
    expect(await response.json()).toEqual(buildRelease)
  })

  test('answers a path with no page with its 404 page and a 404 status', async () => {
    const site = await startSite(productionConfig)

    const response = await fetch(`${site.origin}/no-such-page`)

    expect(response.status).toBe(404)
    expect(await response.text()).toContain('Not found')
  })

  test("resolves GitHub through the container's own DNS server, whichever runtime supplies it", async () => {
    const site = await startSite(productionConfig)

    expect(site.renderedConfig()).toContain(`resolver ${unreachableDns} valid=60s;`)
  })
})

describe('release endpoint', () => {
  test('answers concurrent first visitors from one lookup', async () => {
    const site = await startSite(standInConfig)
    // Large enough for the stand-in to take a second over it, so all eight requests overlap.
    const largeRelease = { ...release('v1'), body: 'x'.repeat(96 * 1024) }
    site.setGitHubAnswer(largeRelease)

    const responses = await Promise.all(Array.from({ length: 8 }, () => site.getRelease()))

    expect(site.gitHubRequestCount()).toBe(1)
    expect(responses.map((response) => response.headers.get('x-release-cache')).sort()).toEqual([
      ...Array.from({ length: 7 }, () => 'HIT'),
      'MISS',
    ])
    for (const response of responses) {
      expect(response.headers.get('content-type')).toBe('application/json')
      expect(await response.json()).toEqual(largeRelease)
    }
  })

  test("asks GitHub in its own name, passing on nothing of the visitor's request", async () => {
    const site = await startSite(standInConfig)
    site.setGitHubAnswer(release('v1'))

    // GitHub answers `?callback=` with a script, which the cache would go on to serve to everyone.
    const response = await site.getRelease('?per_page=1&callback=alert', {
      headers: { cookie: 'session=private', authorization: 'Bearer private', 'user-agent': 'A visitor' },
    })

    expect(response.headers.get('x-release-cache')).toBe('MISS')
    expect(response.headers.get('x-seen-uri')).toBe(releasePath)
    expect(response.headers.get('x-seen-client')).toBe('Thunderbolt-Website accepting application/vnd.github+json')
    expect(response.headers.get('x-seen-credentials')).toBe('cookie= authorization=')
  })

  test("serves the build's release rather than one from a server whose certificate it cannot verify", async () => {
    const site = await startSite(unverifiableConfig)
    site.setGitHubAnswer(release('v1'))

    expect(await (await site.getRelease()).json()).toEqual(buildRelease)
  })

  test('answers every visitor from the one cached release, however their requests differ', async () => {
    const site = await startSite(standInConfig)
    site.setGitHubAnswer(release('v1'))
    expect((await site.getRelease()).headers.get('x-release-cache')).toBe('MISS')

    const next = await site.getRelease('?visitor=another', {
      headers: { accept: 'text/html', 'accept-encoding': 'identity', 'x-requested-with': 'XMLHttpRequest' },
    })

    expect(next.headers.get('x-release-cache')).toBe('HIT')
    expect(await next.json()).toEqual(release('v1'))
  })

  test("serves GitHub's release under this site's caching and transport policy, not GitHub's", async () => {
    const site = await startSite(standInConfig)
    site.setGitHubAnswer(release('v1'))

    for (const cacheStatus of ['MISS', 'HIT']) {
      const response = await site.getRelease()
      expect(response.headers.get('x-release-cache')).toBe(cacheStatus)
      expectSiteHeaders(response)
    }
  })

  test('answers with an expired release while it looks up the next one', async () => {
    const site = await startSiteWithExpiredRelease()
    site.setGitHubAnswer(release('v2'))

    const expired = await site.getRelease()

    expect(expired.headers.get('x-release-cache')).toBe('STALE')
    expect(await expired.json()).toEqual(release('v1'))
    await waitForRelease(site, release('v2'))
  })

  test.each(outages)('keeps serving an expired release, and keeps asking, while lookups end in %s', async (outage) => {
    const site = await startSiteWithExpiredRelease()
    site.setGitHubAnswer(outage)

    // Lookups run one at a time. After the one that cached the release, a third can only
    // have started once a failed one was over and the release had been served again.
    while (site.gitHubRequestCount() < 3) {
      expect(await (await site.getRelease()).json()).toEqual(release('v1'))
    }
  })

  test.each(refusals)(
    "stops asking once a lookup ends in %s, and serves the build's release in place of the expired one",
    async (refusal) => {
      const site = await startSiteWithExpiredRelease()
      site.setGitHubAnswer(refusal)

      await waitForRelease(site, buildRelease)
      for (let request = 0; request < 4; request++) {
        expect(await (await site.getRelease()).json()).toEqual(buildRelease)
      }
      expect(site.gitHubRequestCount()).toBe(2)
    },
  )

  test.each(failures)(
    "serves the build's release, and stops asking, when the first lookup ends in %s",
    async (failure) => {
      const site = await startSite(standInConfig)
      site.setGitHubAnswer(failure)

      for (let request = 0; request < 4; request++) {
        const response = await site.getRelease()
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual(buildRelease)
      }
      expect(site.gitHubRequestCount()).toBe(1)
    },
  )

  test('asks again once a remembered failure has expired, and serves what GitHub then describes', async () => {
    const site = await startSite(forgetfulConfig)
    site.setGitHubAnswer('403')
    expect(await (await site.getRelease()).json()).toEqual(buildRelease)

    site.setGitHubAnswer(release('v1'))
    await Bun.sleep(shortLifetimeMs)

    expect(await (await site.getRelease()).json()).toEqual(release('v1'))
  })

  test('answers HEAD as it answers GET', async () => {
    const site = await startSite(standInConfig)
    site.setGitHubAnswer(release('v1'))

    const response = await site.getRelease('', { method: 'HEAD' })

    expect(response.status).toBe(200)
    expect(response.headers.get('x-release-cache')).toBe('MISS')
  })

  test.each(['POST', 'PUT', 'DELETE'])('refuses %s without asking GitHub', async (method) => {
    const site = await startSite(standInConfig)
    site.setGitHubAnswer(release('v1'))

    const response = await site.getRelease('', { method })

    expect(response.status).toBe(405)
    expect(site.gitHubRequestCount()).toBe(0)
  })
})
