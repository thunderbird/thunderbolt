/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { parseTestScript, selectChangedTests } from './rerun-changed-tests'

const changed = [
  'src/chats/chat-list.test.tsx',
  'src/chats/chat-list.tsx',
  'src/office/office-script-excel.test.ts',
  'shared/defaults/models.test.ts',
  'shared/agent-core/src/loop.test.ts',
  'scripts/thunderbot/select.test.ts',
  'deploy/config/nginx.test.ts',
  'deploy/config/marketing-nginx.test.ts',
  '.github/scripts/post-pr-metrics.test.js',
  'e2e/helpers.test.ts',
  'e2e/oidc-login.spec.ts',
  'backend/src/auth/otp.test.ts',
  'backend/src/proxy/ws-e2e.test.ts',
  'cli/src/main.test.ts',
  'docs/README.md',
]

describe('parseTestScript', () => {
  it('reads cwd, path arguments and ignore patterns from each bun test invocation', () => {
    const script =
      "bun test --cwd=src --timeout 3600000 --rerun-each ${RERUN_EACH:-1} --path-ignore-patterns='office/office-script-*.test.ts' && " +
      'bun test shared/*.test.ts scripts/thunderbot/ ./.github/scripts/a.test.js --randomize && ' +
      'bun test --cwd=e2e helpers.test.ts --timeout 5000'
    expect(parseTestScript(script)).toEqual([
      { cwd: 'src', include: ['src/**/*.test.{ts,tsx,js,mjs}'], exclude: ['src/office/office-script-*.test.ts'] },
      {
        cwd: '.',
        include: ['shared/*.test.ts', 'scripts/thunderbot/**/*.test.{ts,tsx,js,mjs}', '.github/scripts/a.test.js'],
        exclude: [],
      },
      { cwd: 'e2e', include: ['e2e/helpers.test.ts'], exclude: [] },
    ])
  })
})

describe('selectChangedTests', () => {
  it('groups frontend tests by the cwd their suite runs from, leaving other suites out', () => {
    expect(selectChangedTests(changed, 'frontend')).toEqual([
      { cwd: 'src', files: ['chats/chat-list.test.tsx'] },
      {
        cwd: '.',
        files: [
          'shared/defaults/models.test.ts',
          'scripts/thunderbot/select.test.ts',
          '.github/scripts/post-pr-metrics.test.js',
        ],
      },
      { cwd: 'e2e', files: ['helpers.test.ts'] },
    ])
  })

  it('skips test files that test:ci does not run', () => {
    const outside = [
      'scripts/performance/harness.test.ts',
      'e2e/fake-mcp-server.test.ts',
      'deploy/config/marketing-nginx.test.ts',
      'shared/reasoning-effort.test.tsx',
    ]
    expect(selectChangedTests(outside, 'frontend')).toEqual([])
  })

  it('selects only the nginx test for the Docker-backed step', () => {
    expect(selectChangedTests(changed, 'docker')).toEqual([{ cwd: '.', files: ['deploy/config/nginx.test.ts'] }])
  })

  it('selects only the Office script suites for the office job', () => {
    expect(selectChangedTests(changed, 'office')).toEqual([
      { cwd: 'src', files: ['office/office-script-excel.test.ts'] },
    ])
  })

  it('excludes the segregated WebSocket suites from the backend re-run', () => {
    expect(selectChangedTests(changed, 'backend')).toEqual([{ cwd: 'backend', files: ['src/auth/otp.test.ts'] }])
  })

  it('returns no groups when no test file changed', () => {
    expect(selectChangedTests(['src/chats/chat-list.tsx', 'docs/README.md'], 'frontend')).toEqual([])
  })
})
