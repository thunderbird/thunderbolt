/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { evaluate, type ExpressionContext } from './workflow-expression'

type Step = { uses?: string; run?: string }

type Job = {
  name?: string
  needs?: string | string[]
  if?: string
  environment?: string
  uses?: string
  with?: { ref?: string; tag_override?: string }
  steps?: Step[]
}

type Workflow = {
  on: { [event: string]: { types?: string[] } | null }
  concurrency: { group: string; 'cancel-in-progress': boolean }
  jobs: { [name: string]: Job | undefined }
}

const workflow = Bun.YAML.parse(
  readFileSync(join(import.meta.dir, '../.github/workflows/preview-deploy.yml'), 'utf8'),
) as Workflow
const { jobs } = workflow
const approveFork = jobs['approve-fork']

const fakeBin = mkdtempSync(join(tmpdir(), 'preview-workflow-'))
afterAll(() => rmSync(fakeBin, { recursive: true, force: true }))

// Answers `gh pr view` from FAKE_HEAD_*, and any other call with FAKE_GH_BODY / FAKE_GH_STATUS.
writeFileSync(
  join(fakeBin, 'gh'),
  `#!/bin/sh
echo "$*" >> "$FAKE_GH_LOG"
case "$*" in
  *headRefOid*) echo "$FAKE_HEAD_SHA" ;;
  *headRepository*) echo "$FAKE_HEAD_REPO" ;;
  *) printf '%s' "$FAKE_GH_BODY"; exit "\${FAKE_GH_STATUS:-0}" ;;
esac
`,
)
chmodSync(join(fakeBin, 'gh'), 0o755)

/** Runs a workflow `run:` script the way Actions does (`bash -e`), with `gh` stubbed. */
const runScript = (script: string, env: Record<string, string>) => {
  const outputFile = join(fakeBin, `output-${crypto.randomUUID()}`)
  const ghLog = join(fakeBin, `gh-${crypto.randomUUID()}`)
  writeFileSync(outputFile, '')
  writeFileSync(ghLog, '')
  const result = Bun.spawnSync(['bash', '-e', '-c', script], {
    env: {
      ...process.env,
      ...env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      GITHUB_OUTPUT: outputFile,
      FAKE_GH_LOG: ghLog,
    },
  })
  const outputs = Object.fromEntries(
    readFileSync(outputFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('=', 2) as [string, string]),
  )
  return { exitCode: result.exitCode, outputs, ghCalls: readFileSync(ghLog, 'utf8') }
}

/** Interpolates every `${{ }}` in a template string, such as the concurrency group. */
const interpolate = (template: string, context: ExpressionContext) =>
  template.replace(/\$\{\{(.*?)\}\}/g, (_, expression: string) => String(evaluate(expression, context)))

const resolveScript = jobs.resolve?.steps?.find((step) => step.run?.includes('EVENT_NAME'))?.run ?? ''
const approvalScript = approveFork?.steps?.find((step) => step.run?.includes('environments/'))?.run ?? ''

const eventHeadSha = 'a'.repeat(40)
const dispatchHeadSha = 'b'.repeat(40)

const resolveFor = (event: string, headRepo: string) =>
  runScript(resolveScript, {
    EVENT_NAME: event,
    EVENT_PR_NUMBER: event === 'workflow_dispatch' ? '' : '42',
    EVENT_HEAD_SHA: event === 'workflow_dispatch' ? '' : eventHeadSha,
    EVENT_HEAD_REPO: event === 'workflow_dispatch' ? '' : headRepo,
    EVENT_BASE_REPO: 'acme/repo',
    INPUT_PR_NUMBER: event === 'workflow_dispatch' ? '42' : '',
    FAKE_HEAD_SHA: dispatchHeadSha,
    FAKE_HEAD_REPO: headRepo,
  })

/** Whether the approval job runs, and whether publish and deploy follow, for one resolve result. */
const gate = (resolved: { proceed?: string; is_fork?: string }, approvalResult: string, { cancelled = false } = {}) => {
  const context = {
    'needs.resolve.outputs.proceed': resolved.proceed ?? '',
    'needs.resolve.outputs.is_fork': resolved.is_fork ?? '',
    'needs.approve-fork.result': approvalResult,
    'needs.publish.result': 'success',
    'cancelled()': cancelled,
  }
  return {
    approvalRuns: evaluate(approveFork?.if ?? 'false', context) === true,
    publishes: evaluate(jobs.publish?.if ?? 'false', context) === true,
    deploys: evaluate(jobs.deploy?.if ?? 'false', context) === true,
  }
}

describe('preview deploy trust policy', () => {
  it.each([
    ['pull_request', 'acme/repo', 'true', 'false'],
    ['pull_request', 'someone/fork', 'false', undefined],
    ['pull_request_target', 'someone/fork', 'true', 'true'],
    ['pull_request_target', 'acme/repo', 'false', undefined],
    ['workflow_dispatch', 'acme/repo', 'true', 'false'],
    ['workflow_dispatch', 'someone/fork', 'true', 'true'],
  ])('routes %s from %s to exactly one run', (event, headRepo, proceed, isFork) => {
    const { exitCode, outputs } = resolveFor(event, headRepo)
    expect(exitCode).toBe(0)
    expect(outputs.proceed).toBe(proceed)
    expect(outputs.is_fork).toBe(isFork)
  })

  it.each([
    ['pull_request', 'acme/repo'],
    ['workflow_dispatch', 'acme/repo'],
  ])('deploys a same-repo PR on %s without waiting for approval', (event, headRepo) => {
    const resolved = resolveFor(event, headRepo).outputs
    expect(gate(resolved, 'skipped')).toEqual({ approvalRuns: false, publishes: true, deploys: true })
  })

  it.each([
    ['pull_request_target', 'someone/fork'],
    ['workflow_dispatch', 'someone/fork'],
  ])('holds a fork PR on %s for manual approval', (event, headRepo) => {
    const resolved = resolveFor(event, headRepo).outputs
    expect(gate(resolved, 'success')).toEqual({ approvalRuns: true, publishes: true, deploys: true })
    for (const result of ['skipped', 'failure', 'cancelled']) {
      expect(gate(resolved, result).publishes).toBe(false)
    }
    expect(approveFork?.environment).toBe('fork-preview-approval')
  })

  it('deploys nothing for the no-op runs', () => {
    expect(gate(resolveFor('pull_request', 'someone/fork').outputs, 'skipped').publishes).toBe(false)
    expect(gate(resolveFor('pull_request_target', 'acme/repo').outputs, 'skipped').publishes).toBe(false)
  })

  it('stops publishing and deploying once a newer push cancels the run', () => {
    const internal = resolveFor('pull_request', 'acme/repo').outputs
    const fork = resolveFor('pull_request_target', 'someone/fork').outputs
    expect(gate(internal, 'skipped', { cancelled: true })).toMatchObject({ publishes: false, deploys: false })
    expect(gate(fork, 'success', { cancelled: true })).toMatchObject({ publishes: false, deploys: false })
  })

  it('runs no PR code before the approval', () => {
    for (const job of [jobs.resolve, approveFork]) {
      expect(job?.uses).toBeUndefined()
      expect(job?.steps?.filter((step) => step.uses)).toEqual([])
    }
  })

  it('builds and tags exactly the head SHA the reviewer is shown', () => {
    const headSha = '${{ needs.resolve.outputs.head_sha }}'
    expect(approveFork?.name).toContain(headSha)
    expect(jobs.publish?.with?.ref).toBe(headSha)
    expect(jobs.publish?.with?.tag_override).toContain(headSha)

    expect(resolveFor('pull_request_target', 'someone/fork').outputs.head_sha).toBe(eventHeadSha)
    expect(resolveFor('workflow_dispatch', 'someone/fork').outputs.head_sha).toBe(dispatchHeadSha)
  })

  it('makes a new push start a new run', () => {
    for (const event of ['pull_request', 'pull_request_target']) {
      expect(workflow.on[event]?.types).toEqual(expect.arrayContaining(['synchronize', 'reopened']))
    }
    expect(workflow.concurrency['cancel-in-progress']).toBe(true)
  })

  // Every run that can deploy shares one group, so a push cancels them all, dispatched ones included.
  it.each([
    ['a same-repo pull_request', 'deploy', 'pull_request', 'acme/repo'],
    ['a fork pull_request_target', 'deploy', 'pull_request_target', 'someone/fork'],
    ['a dispatch', 'deploy', 'workflow_dispatch', null],
    ['the no-op fork pull_request', 'pull_request', 'pull_request', 'someone/fork'],
    ['the no-op same-repo pull_request_target', 'pull_request_target', 'pull_request_target', 'acme/repo'],
  ])('puts %s in the %s group', (_, group, event, headRepo) => {
    const dispatch = event === 'workflow_dispatch'
    expect(
      interpolate(workflow.concurrency.group, {
        'github.event_name': event,
        'github.event.pull_request.number': dispatch ? null : 42,
        'inputs.pr_number': dispatch ? '42' : null,
        'github.event.pull_request.head.repo.full_name': headRepo,
        'github.repository': 'acme/repo',
      }),
    ).toBe(`preview-pr-42-${group}`)
  })
})

/** The parts of GitHub's "get an environment" response (or its 404 body) the check reads. */
type EnvironmentResponse = {
  protection_rules?: { type: string; reviewers?: { type: string; reviewer: { slug: string } }[] }[]
  message?: string
}

describe('fork approval environment check', () => {
  const runCheck = (body: EnvironmentResponse, status = 0) =>
    runScript(approvalScript, { REPO: 'acme/repo', FAKE_GH_BODY: JSON.stringify(body), FAKE_GH_STATUS: String(status) })

  const reviewers = { type: 'required_reviewers', reviewers: [{ type: 'Team', reviewer: { slug: 'maintainers' } }] }

  it('reads the environment the approval job uses', () => {
    expect(runCheck({ protection_rules: [reviewers] }).ghCalls).toBe(
      `api repos/acme/repo/environments/${approveFork?.environment}\n`,
    )
  })

  it('passes when required reviewers protect the environment', () => {
    expect(runCheck({ protection_rules: [{ type: 'branch_policy' }, reviewers] }).exitCode).toBe(0)
  })

  it.each([
    ['has no rules', { protection_rules: [] }, 0],
    [
      'only has a wait timer and a branch policy',
      { protection_rules: [{ type: 'wait_timer' }, { type: 'branch_policy' }] },
      0,
    ],
    ['lists no reviewers', { protection_rules: [{ type: 'required_reviewers', reviewers: [] }] }, 0],
    ['does not exist', { message: 'Not Found' }, 1],
  ])('fails closed when the environment %s', (_, body, status) => {
    expect(runCheck(body, status).exitCode).not.toBe(0)
  })
})
