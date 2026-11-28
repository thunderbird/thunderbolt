/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { join, relative } from 'node:path'
import packageJson from '../package.json'

/** A CI test job whose changed test files get re-run five times on pull requests. */
export type Scope = 'frontend' | 'docker' | 'office' | 'backend'

/** Test files to run from one working directory, as paths relative to it. */
export type TestGroup = { cwd: string; files: string[] }

/** Repo-relative globs selecting the test files one `bun test` invocation runs from `cwd`. */
export type GroupRule = { cwd: string; include: string[]; exclude?: string[] }

const testFile = '*.test.{ts,tsx,js,mjs}'
const officeScriptTest = 'src/**/office/office-script-*.test.ts'
const valueFlags = new Set(['--timeout', '--rerun-each'])

/** Turns one `bun test` path argument, relative to its cwd, into a glob: a directory covers its test files. */
const toGlob = (cwd: string, arg: string) => join(cwd, arg.endsWith('/') ? `${arg}**/${testFile}` : arg)

/**
 * Reads the `bun test` invocations of a package.json script (joined with `&&`) as group rules, so the
 * re-run selects exactly the files that script runs. An invocation with no path arguments covers its cwd.
 */
export const parseTestScript = (script: string): GroupRule[] =>
  script
    .split('&&')
    .map((segment) => segment.trim().split(/\s+/))
    .filter(([bin, command]) => bin === 'bun' && command === 'test')
    .map((tokens) => {
      const args = tokens.slice(2).filter((_token, i, all) => !valueFlags.has(all[i - 1] ?? ''))
      const cwd = args.find((arg) => arg.startsWith('--cwd='))?.slice('--cwd='.length) ?? '.'
      const paths = args.filter((arg) => !arg.startsWith('-'))
      const ignores = args
        .filter((arg) => arg.startsWith('--path-ignore-patterns='))
        .map((arg) => arg.slice('--path-ignore-patterns='.length).replace(/^'|'$/g, ''))
      return {
        cwd,
        include: paths.length > 0 ? paths.map((path) => toGlob(cwd, path)) : [join(cwd, `**/${testFile}`)],
        exclude: ignores.map((pattern) => join(cwd, pattern)),
      }
    })

// Each scope mirrors what its CI step runs, so a file is re-run from the cwd (and bunfig preload) it
// normally runs under. The frontend and Docker lists are read from `test:ci` and `test:docker` themselves;
// the Office and backend steps run every test file under their tree.
const rules: Record<Scope, GroupRule[]> = {
  frontend: parseTestScript(packageJson.scripts['test:ci']),
  docker: parseTestScript(packageJson.scripts['test:docker']),
  office: [{ cwd: 'src', include: [officeScriptTest] }],
  backend: [
    {
      cwd: 'backend',
      include: [`backend/src/**/${testFile}`],
      // Run once with retries in their own step; see the backend job in ci.yml.
      exclude: ['backend/src/proxy/ws-e2e.test.ts', 'backend/src/haystack/routes.test.ts'],
    },
  ],
}

/** Whether the repo-relative `file` matches at least one of the glob `patterns`. */
const matchesAny = (patterns: string[], file: string) => patterns.some((pattern) => new Bun.Glob(pattern).match(file))

/** Group the changed repo-relative paths that are test files in `scope` by the cwd they run from. */
export const selectChangedTests = (changedFiles: string[], scope: Scope): TestGroup[] =>
  rules[scope]
    .map(({ cwd, include, exclude = [] }) => ({
      cwd,
      files: changedFiles
        .filter((file) => matchesAny(include, file) && !matchesAny(exclude, file))
        .map((file) => relative(cwd, file)),
    }))
    .filter((group) => group.files.length > 0)

/** Narrows a CLI argument to a known `Scope`; undefined or unknown names are not scopes. */
const isScope = (value: string | undefined): value is Scope => value !== undefined && value in rules

if (import.meta.main) {
  const scope = process.argv[2]
  if (!isScope(scope)) {
    console.error(`Usage: bun scripts/rerun-changed-tests.ts <${Object.keys(rules).join('|')}>`)
    process.exit(2)
  }
  // A pull_request checkout is the merge commit, so its first parent is the base branch.
  const base = process.env.RERUN_BASE ?? 'HEAD^1'
  const changed = (await Bun.$`git diff --name-only --diff-filter=d ${base} HEAD`.text()).split('\n').filter(Boolean)
  const groups = selectChangedTests(changed, scope)
  if (groups.length === 0) {
    console.log(`No changed ${scope} test files.`)
    process.exit(0)
  }
  for (const { cwd, files } of groups) {
    console.log(`Re-running 5x from ${cwd}:\n  ${files.join('\n  ')}`)
    await Bun.$`bun test --timeout 3600000 --randomize --rerun-each 5 ${files.map((file) => `./${file}`)}`.cwd(cwd)
  }
}
