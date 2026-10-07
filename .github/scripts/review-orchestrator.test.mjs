/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// =============================================================================
// Pure-helper tests for review-orchestrator.mjs (bun:test, the repo standard
// for .github/scripts/ — see post-pr-metrics.test.js + package.json `test`).
//
// Focus: the precision-gate terminal logic. The gate (workflow step 2) filters
// the recall candidates down to a KEPT subset before the orchestrator sees them,
// so from the orchestrator's view the gate's output is just `findings`. We prove:
//   1. gate-empty   → no inline posts + a clean affirmative "no issues" state
//      (and that state is NOT re-posted once it's already the latest review).
//   2. gate-keeps-subset → ONLY the kept subset is posted as inline comments.
// =============================================================================

import { describe, test, expect, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { getClock } from '../../src/testing-library';

import {
  paginateAll,
  graphqlFetch,
  summarizeExecution,
  parseUnifiedDiff,
  buildUnifiedDiff,
  computeDeepMode,
  matchesSecurityPath,
  normalizeFindings,
  classifyFindings,
  selectFindingsToPost,
  decideTerminalAction,
  latestOwnReviewIsNoIssues,
  summarizedHashesFromBodies,
  buildReviewPayload,
  buildNoIssuesPayload,
  NO_ISSUES_MARKER,
  SUMMARY_HEADING,
} from './review-orchestrator.mjs';

const inlineFinding = (over) => ({
  severity: 'blocking',
  side: 'RIGHT',
  title: 't',
  body: 'b',
  rule: 'R',
  ...over,
});

const reviewedSha = 'a'.repeat(40);
const currentSha = 'b'.repeat(40);
const checkpoint = `<!-- thunder-deep-review-head:${reviewedSha} -->`;
const fullFiles = [
  { filename: 'src/a.ts', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-oldValue();\n+newValue();' },
  { filename: 'src/crypto/key.ts', additions: 700, deletions: 0, patch: '@@ -0,0 +1 @@\n+encrypt();' },
];
const deltaFile = { filename: 'src/a.ts', additions: 1, deletions: 1,
  patch: '@@ -8 +8 @@\n-oldDelta();\n+newDelta();' };

/** Run the real pre/post entrypoints against a local GitHub fixture server. */
const runReview = async ({ action = 'synchronize', labels = '', reviews = [{ body: checkpoint,
  author: { login: 'github-actions' } }], threads = [], compare = { status: 'ahead',
  merge_base_commit: { sha: reviewedSha }, files: [deltaFile] }, compareStatus = 200,
  files = fullFiles, findings, replyPage } = {}) => {
  getClock().uninstall(); // The fixture server needs real network callbacks.
  const dir = mkdtempSync(join(tmpdir(), 'thunder-incremental-'));
  const posts = [];
  const reads = [];
  const connection = (nodes) => ({ nodes, pageInfo: { hasNextPage: false } });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const json = (value, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    if (url.pathname === '/graphql') {
      const { query } = JSON.parse(body);
      reads.push(query);
      if (query.includes('node(id:') && replyPage === null) return json({ errors: [{ message: 'Reply page unavailable' }] });
      if (query.includes('node(id:')) return json({ data: { node: {
        comments: connection(replyPage),
      } } });
      const key = query.includes('reviewThreads(') ? 'reviewThreads' : 'reviews';
      return json({ data: { repository: { pullRequest: { [key]: connection(
        key === 'reviews' ? reviews : threads,
      ) } } } });
    }
    if (request.method === 'POST') {
      posts.push(JSON.parse(body));
      return json({ id: 1 });
    }
    reads.push(url.pathname);
    if (url.pathname.includes('/compare/')) return json({ commits: [{ parents: [{ sha: reviewedSha }] }],
      total_commits: 1, ...compare }, compareStatus);
    if (url.pathname.endsWith('/files')) return json(files);
    return json('Unexpected request', 404);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const paths = {
    THUNDER_DIFF_FILE: join(dir, 'diff.patch'), THUNDER_PR_DIFF_FILE: join(dir, 'pr.patch'),
    THUNDER_DEEPMODE_FILE: join(dir, 'mode.json'), THUNDER_PREVIOUS_FINDINGS_FILE: join(dir, 'previous.json'),
    THUNDER_FINDINGS_FILE: join(dir, 'findings.json'), GITHUB_OUTPUT: join(dir, 'output'),
  };
  const run = async (phase) => {
    const child = Bun.spawn(['node', fileURLToPath(new URL('./review-orchestrator.mjs', import.meta.url)), phase], {
      env: { ...process.env, ...paths, GITHUB_TOKEN: 'test', GITHUB_REPOSITORY: 'test/repo',
        PR_NUMBER: '1', PR_HEAD_SHA: currentSha, PR_ACTION: action, PR_LABELS: labels,
        GITHUB_API_URL: origin, GITHUB_GRAPHQL_URL: `${origin}/graphql` },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      Bun.readableStreamToText(child.stdout), Bun.readableStreamToText(child.stderr), child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(stdout).not.toContain('FAIL-SOFT');
  };
  try {
    await run('pre');
    if (findings !== undefined && !JSON.parse(readFileSync(paths.THUNDER_DEEPMODE_FILE, 'utf8')).skip) {
      writeFileSync(paths.THUNDER_FINDINGS_FILE, JSON.stringify({ findings }));
      await run('post');
    }
    return {
      diff: readFileSync(paths.THUNDER_DIFF_FILE, 'utf8'),
      mode: JSON.parse(readFileSync(paths.THUNDER_DEEPMODE_FILE, 'utf8')),
      previous: JSON.parse(readFileSync(paths.THUNDER_PREVIOUS_FINDINGS_FILE, 'utf8')),
      previousBytes: readFileSync(paths.THUNDER_PREVIOUS_FINDINGS_FILE).byteLength,
      output: readFileSync(paths.GITHUB_OUTPUT, 'utf8'), posts, reads,
    };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
};

describe('incremental pre/post', () => {
  test('pre omits generated patches, lists their paths and keeps reviewable files', async () => {
    const omitted = ['bun.lock', 'cli/bun.lock', 'src-tauri/Cargo.lock', 'web/package-lock.json',
      'backend/src/emails/locales/en/messages.ts', 'backend/drizzle/meta/0001_snapshot.json',
      'src/acp/iroh/pkg/thunderbolt_acp_client.js', 'src/acp/iroh/pkg/thunderbolt_acp_client_bg.wasm'];
    const retained = ['docs/guide.md', 'src/locales/en/messages.po', 'backend/drizzle/meta/_journal.json',
      'backend/drizzle/0001_migration.sql', 'src/feature.ts', 'src-tauri/gen/android/app/build.gradle.kts'];
    const files = [...omitted, ...retained].map((filename, index) => ({ filename, status: 'added',
      additions: 1, deletions: 0, patch: `@@ -0,0 +1 @@\n+content-${index}` }));
    for (const action of ['opened', 'synchronize']) {
      const result = await runReview({ action, files, compare: { status: 'ahead',
        merge_base_commit: { sha: reviewedSha }, files } });
      const [notice, ...patch] = result.diff.split('\n');
      for (const [index, filename] of omitted.entries()) {
        expect(notice).toContain(JSON.stringify(filename));
        expect(patch.join('\n')).not.toContain(filename);
        expect(result.diff).not.toContain(`+content-${index}\n`);
      }
      for (const [index, filename] of retained.entries()) {
        expect(result.diff).toContain(`diff --git a/${filename} b/${filename}`);
        expect(result.diff).toContain(`+content-${index + omitted.length}\n`);
      }
      expect(result.mode.skip).toBe(false);
    }
    const generatedOnly = await runReview({ action: 'opened', files: files.slice(0, omitted.length) });
    expect(generatedOnly.output).toContain('skip=true');
  });

  test('reviews only delta hunks in PR files, with delta mode gates and full-PR anchors', async () => {
    const result = await runReview({ compare: { status: 'ahead', merge_base_commit: { sha: reviewedSha },
      files: [deltaFile, { filename: 'outside-pr.ts', additions: 900 }] },
      findings: [inlineFinding({ file: 'src/a.ts', line: 8 })] });
    expect(result.diff).toContain('+newDelta();');
    expect(result.diff).not.toContain('newValue');
    expect(result.diff).not.toContain('crypto');
    expect(result.diff).not.toContain('outside-pr');
    expect(result.mode).toMatchObject({ incremental: true, deepMode: false, securityMode: false, changedLines: 2 });
    expect(result.output).toContain('skip=false');
    expect(result.posts[0].comments[0]).toMatchObject({ path: 'src/a.ts', subject_type: 'file' });
    expect(result.posts[0].body).toContain(`<!-- thunder-deep-review-head:${currentSha} -->`);
    expect(result.reads.filter((entry) => entry.includes('/compare/'))).toEqual([
      `/repos/test/repo/compare/${reviewedSha}...${currentSha}`,
    ]);
    expect(result.reads.filter((entry) => entry.includes('reviews(first:'))).toHaveLength(1);
    expect(result.reads.filter((entry) => entry.includes('reviewThreads(first:'))).toHaveLength(1);
  });

  test.each(['diverged', 'behind'])('force-push (%s) falls back to full review', async (status) => {
    const result = await runReview({ compare: { status, merge_base_commit: { sha: 'c'.repeat(40) }, files: [deltaFile] } });
    expect(result.diff).toContain('encrypt();');
    expect(result.mode).toMatchObject({ incremental: false, deepMode: true, securityMode: true });
  });

  test.each([
    { commits: [{ parents: [{ sha: reviewedSha }, { sha: 'c'.repeat(40) }] }], total_commits: 1 },
    { commits: [{ parents: [{ sha: reviewedSha }] }], total_commits: 2 },
  ])('merge or truncated commits fall back to full review', async (commits) => {
    const result = await runReview({ compare: { status: 'ahead', merge_base_commit: { sha: reviewedSha },
      files: [deltaFile], ...commits } });
    expect(result.mode).toMatchObject({ incremental: false, deepMode: true, securityMode: true });
    expect(result.diff).toContain('encrypt();');
  });

  test.each(['opened', 'reopened', 'ready_for_review', 'labeled'])('%s reviews the full PR', async (action) => {
    const result = await runReview({ action });
    expect(result.diff).toContain('encrypt();');
    expect(result.reads.some((entry) => entry.includes('/compare/'))).toBe(false);
  });

  test('review:full left on the PR does not override later synchronize events', async () => {
    const result = await runReview({ labels: 'other,review:full' });
    expect(result.mode.incremental).toBe(true);
    expect(result.diff).toContain('newDelta();');
  });

  test.each([[], [{ body: 'legacy review', author: { login: 'github-actions' } }],
    [{ body: `${checkpoint}<!-- thunder-deep-review-finding -->`, author: { login: 'human' } }]])(
    'missing or unauthenticated checkpoint falls back to full', async (...reviews) => {
      const result = await runReview({ reviews });
      expect(result.mode.incremental).toBe(false);
      expect(result.diff).toContain('encrypt();');
    });

  test('empty delta skips model work and does not advance checkpoint', async () => {
    const result = await runReview({ compare: { status: 'ahead', merge_base_commit: { sha: reviewedSha }, files: [] }, findings: [] });
    expect(result.mode).toMatchObject({ incremental: true, skip: true });
    expect(result.output).toContain('skip=true');
    expect(result.posts).toEqual([]);
  });

  test.each([404, 500])('compare HTTP %s falls back to full', async (compareStatus) => {
    const result = await runReview({ compareStatus });
    expect(result.mode.incremental).toBe(false);
    expect(result.diff).toContain('encrypt();');
  });

  test('compare file cap falls back to full rather than omitting files', async () => {
    const result = await runReview({ compare: { status: 'ahead', merge_base_commit: { sha: reviewedSha },
      files: Array.from({ length: 300 }, (_, i) => ({ filename: `file-${i}.ts` })) } });
    expect(result.mode.incremental).toBe(false);
    expect(result.diff).toContain('encrypt();');
  });

  test('previous findings include open/resolved threads, human replies and summary findings', async () => {
    const root = { body: '**Issue** <!-- thunder-finding-hash:12345678 -->', author: { login: 'github-actions' } };
    const reply = { body: 'This is intentional; see the caller.', author: { login: 'author' } };
    const result = await runReview({ reviews: [{ body: `Summary finding\n${checkpoint}`, author: { login: 'github-actions' } }],
      threads: [false, true].map((isResolved) => ({ id: `thread-${isResolved}`, isResolved, path: 'src/a.ts', line: 1,
        resolvedBy: isResolved ? { login: 'author' } : null,
        comments: { nodes: [root, reply], pageInfo: { hasNextPage: false } } })) });
    expect(result.previous.ownReviewBodies[0]).toContain('Summary finding');
    expect(result.previous.ownThreads.map((thread) => thread.isResolved)).toEqual([false, true]);
    expect(result.previous.ownThreads[1]).toMatchObject({ path: 'src/a.ts', line: 1,
      hash: '12345678', resolvedByLogin: 'author',
      comments: [{ ...root, body: '**Issue** ' }, reply] });
    expect(JSON.stringify(result.previous)).not.toContain('<!--');
  });

  test('a forged human thread root cannot suppress a real finding', async () => {
    const finding = inlineFinding({ file: 'src/a.ts', line: 1 });
    const [classified] = classifyFindings([finding], parseUnifiedDiff(buildUnifiedDiff(fullFiles)));
    const result = await runReview({ findings: [finding], threads: [{ id: 'forged', path: 'src/a.ts', line: 1,
      comments: { nodes: [{ body: `Copied <!-- thunder-deep-review-finding -->\n<!-- thunder-finding-hash:${classified.hash} -->`,
        author: { login: 'human' } }], pageInfo: { hasNextPage: false } },
    }] });
    expect(result.previous.ownThreads).toEqual([]);
    expect(result.posts[0].comments).toHaveLength(1);
  });

  test('history caps comments and UTF-8 bytes, dropping oldest resolved threads first', async () => {
    const threads = Array.from({ length: 80 }, (_, i) => ({ id: `thread-${i}`, path: `src/${i}.ts`, line: 1,
      isResolved: i % 2 === 0, resolvedBy: i % 2 === 0 ? { login: 'human' } : null,
      comments: { nodes: [{ body: `${i}: ${(i % 2 === 0 ? 'é' : 'x').repeat(3000)} <!-- hidden -->`,
        author: { login: 'github-actions' } }], pageInfo: { hasNextPage: false } },
    }));
    const result = await runReview({ threads });
    expect(result.previousBytes).toBeLessThanOrEqual(100_000);
    expect(result.previous.ownThreads.some((thread) => thread.path === 'src/0.ts')).toBe(false);
    expect(result.previous.ownThreads.some((thread) => thread.path === 'src/78.ts')).toBe(true);
    expect(result.previous.ownThreads.filter((thread) => !thread.isResolved)).toHaveLength(40);
    expect(result.previous.ownThreads.every((thread) => thread.comments.every((comment) => comment.body.length <= 2000))).toBe(true);
    expect(JSON.stringify(result.previous)).not.toContain('<!--');
  });

  test('sanitized and truncated review text retains summary dedup state', async () => {
    const finding = inlineFinding({ file: 'absent.ts', line: 1 });
    const [classified] = classifyFindings([finding], parseUnifiedDiff(buildUnifiedDiff(fullFiles)));
    const result = await runReview({ reviews: [{ body: `${checkpoint}\n${'x'.repeat(3000)}\n<!-- thunder-finding-hash:${classified.hash} -->`,
      author: { login: 'github-actions' } }], findings: [finding] });
    expect(result.previous.ownReviewBodies[0].length).toBeLessThanOrEqual(2000);
    expect(result.previous.summarizedHashes).toEqual([classified.hash]);
    expect(result.posts).toEqual([]);
  });

  test('discarded history threads retain open and human-resolved dedup hashes', async () => {
    const findings = [1, 2].map((line) => inlineFinding({ file: 'src/a.ts', line }));
    const classified = classifyFindings(findings, parseUnifiedDiff(buildUnifiedDiff(fullFiles)));
    const threads = Array.from({ length: 80 }, (_, i) => ({ id: `thread-${i}`, path: `src/${i}.ts`, line: 1,
      isResolved: i === 0, resolvedBy: i === 0 ? { login: 'human' } : null,
      comments: { nodes: [{ body: `${'é'.repeat(3000)}${i < 2 ? ` <!-- thunder-finding-hash:${classified[i].hash} -->` : ''}`,
        author: { login: 'github-actions' } }], pageInfo: { hasNextPage: false } },
    }));
    const result = await runReview({ threads, findings });
    expect(result.previousBytes).toBeLessThanOrEqual(100_000);
    expect(result.previous.ownThreads.some((thread) => ['src/0.ts', 'src/1.ts'].includes(thread.path))).toBe(false);
    expect(result.previous.humanResolvedHashes).toEqual([classified[0].hash]);
    expect(result.previous.openHashes).toEqual([classified[1].hash]);
    expect(result.posts).toEqual([]);
  });

  test('human replies beyond the first comment page reach recall', async () => {
    const root = { body: 'Original finding', author: { login: 'github-actions' } };
    const refutation = { body: 'Refuted with a reproduction.', author: { login: 'author' } };
    const result = await runReview({ threads: [{ id: 'thread', path: 'src/a.ts', line: 1,
      comments: { nodes: [root], pageInfo: { hasNextPage: true, endCursor: 'comments-page-2' } },
    }], replyPage: [refutation] });
    expect(result.previous.ownThreads[0].comments).toEqual([root, refutation]);
  });

  test('a failed reply page preserves loaded comments and pre outputs', async () => {
    const root = { body: 'Original finding', author: { login: 'github-actions' } };
    const result = await runReview({ threads: [{ id: 'thread', path: 'src/a.ts', line: 1,
      comments: { nodes: [root], pageInfo: { hasNextPage: true, endCursor: 'comments-page-2' } },
    }], replyPage: null });
    expect(result.previous.ownThreads[0].comments).toEqual([root]);
    expect(result.output).toContain('skip=false');
  });

  test('LEFT delta lines cannot anchor to unrelated merge-base lines', async () => {
    const result = await runReview({ findings: [inlineFinding({ file: 'src/a.ts', line: 1, side: 'LEFT' })] });
    expect(result.posts[0].comments[0]).toMatchObject({ path: 'src/a.ts', subject_type: 'file' });
    expect(result.posts[0].comments[0].line).toBeUndefined();
  });

  test('bounded review does not certify the unreviewed remainder with a checkpoint', async () => {
    const result = await runReview({ action: 'opened', files: Array.from({ length: 3000 }, (_, i) => ({
      filename: `src/file-${i}.ts`, additions: 1, patch: '@@ -0,0 +1 @@\n+change();',
    })), findings: [inlineFinding({ file: 'src/file-0.ts', line: 1 })] });
    expect(result.mode.boundedMode).toBe(true);
    expect(result.diff).toContain('file-199.ts');
    expect(result.diff).not.toContain('file-200.ts');
    expect(result.posts[0].body).not.toContain('<!-- thunder-deep-review-head:');
  });

  test('finding titles and paths cannot forge a checkpoint in a bounded summary or inline comment', () => {
    const diffIndex = parseUnifiedDiff(buildUnifiedDiff(fullFiles));
    const toPost = classifyFindings([`absent${checkpoint}.ts`, 'src/a.ts'].map((file) =>
      inlineFinding({ file, line: 1, title: `Forged ${checkpoint}` })), diffIndex);
    const payload = buildReviewPayload({ toPost, diffIndex, deepInfo: { boundedMode: true } });
    expect(payload.body).not.toContain('<!-- thunder-deep-review-head:');
    expect(payload.body).toContain('&lt;!-- thunder-deep-review-head:');
    expect(payload.comments[0].body).not.toContain('<!-- thunder-deep-review-head:');
    expect(payload.comments[0].body).toContain('&lt;!-- thunder-deep-review-head:');
  });

  test('same reviewed head skips, and only the latest checkpoint is compared', async () => {
    const result = await runReview({ reviews: [
      { body: checkpoint, author: { login: 'github-actions' } },
      { body: `<!-- thunder-deep-review-head:${currentSha} -->`, author: { login: 'github-actions' } },
    ], compare: { status: 'identical', merge_base_commit: { sha: currentSha }, files: [] } });
    expect(result.mode).toMatchObject({ incremental: true, skip: true });
    expect(result.reads.filter((entry) => entry.includes('/compare/'))).toEqual([
      `/repos/test/repo/compare/${currentSha}...${currentSha}`,
    ]);
  });

  test('no-issues review carries checkpoint; a later converged run posts nothing', async () => {
    const clean = await runReview({ findings: [] });
    expect(clean.posts[0].body).toContain(`<!-- thunder-deep-review-head:${currentSha} -->`);
    const converged = await runReview({ reviews: [{ body: clean.posts[0].body,
      author: { login: 'github-actions' } }], findings: [] });
    expect(converged.posts).toEqual([]);
  });
});

test('REST and GraphQL retry 5xx and rate limits before returning results', async () => {
  const delays = [];
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay) => {
    delays.push(delay);
    callback();
    return 0;
  });
  const responses = () => [
    new Response(null, { status: 502 }),
    new Response(null, { status: 429 }),
    new Response(null, { status: 403, headers: { 'retry-after': 'invalid', 'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 3600) } }),
  ];
  const queue = [...responses(), Response.json([{ filename: 'src/app.tsx' }]),
    ...responses(), Response.json({ data: { repository: { id: 'repo' } } })];
  const request = spyOn(globalThis, 'fetch').mockImplementation(async () => queue.shift());
  try {
    expect(await paginateAll('https://example.test/files')).toEqual({
      items: [{ filename: 'src/app.tsx' }], truncated: false,
    });
    expect(await graphqlFetch('query { repository { id } }', {})).toEqual({
      ok: true, data: { repository: { id: 'repo' } }, errors: null,
    });
    expect(request).toHaveBeenCalledTimes(8);
    expect(delays).toHaveLength(6);
    for (const offset of [0, 3]) {
      expect(delays[offset]).toBeGreaterThanOrEqual(24_000);
      expect(delays[offset]).toBeLessThanOrEqual(36_000);
      expect(delays[offset + 1]).toBeGreaterThanOrEqual(48_000);
      expect(delays[offset + 1]).toBeLessThanOrEqual(72_000);
      expect(delays[offset + 2]).toBeGreaterThanOrEqual(60_000);
      expect(delays[offset + 2]).toBeLessThanOrEqual(72_000);
    }
  } finally {
    request.mockRestore();
    timer.mockRestore();
  }
});

// A tiny two-file diff: one added line in each file, used across scenarios.
const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,1 +1,2 @@',
  ' const a = 1;',
  '+const danger = useUnsafe();',
  'diff --git a/src/b.ts b/src/b.ts',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -1,1 +1,2 @@',
  ' const b = 1;',
  '+const styleNit = 2;',
].join('\n');

const blockerCandidate = {
  severity: 'blocking',
  file: 'src/a.ts',
  line: 2,
  side: 'RIGHT',
  title: 'Unsafe call',
  body: 'This crashes.',
  rule: 'INV-01',
};

const noPrior = { openHashes: new Set(), humanResolvedHashes: new Set(), summarizedHashes: new Set() };

// ---------------------------------------------------------------------------
// SCENARIO 1 — gate returns EMPTY (clean diff): no inline posts, clean no-issues.
// ---------------------------------------------------------------------------

describe('gate-empty: clean diff converges to an affirmative no-issues state', () => {
  test('terminal action is the affirmative no-issues note', () => {
    const decision = decideTerminalAction({
      findingCount: 0,
      eventAction: 'synchronize',
      ownReviewBodies: [],
      openThreadsRemain: false,
    });
    expect(decision.action).toBe('no-issues');
  });

  test('no-issues payload has ZERO inline comments + the marker', () => {
    const payload = buildNoIssuesPayload({ deepInfo: { deepMode: false, boundedMode: false } });
    expect(payload.event).toBe('COMMENT');
    expect(payload.comments.length).toBe(0); // affirmative note posts no inline comments
    expect(payload.body).toContain(NO_ISSUES_MARKER);
    expect(payload.body).toMatch(/no issues/i);
  });

  test('does NOT re-post when the latest own review is already no-issues', () => {
    const priorNoIssues = buildNoIssuesPayload({ deepInfo: {} }).body;
    expect(latestOwnReviewIsNoIssues([priorNoIssues])).toBe(true);
    const decision = decideTerminalAction({
      findingCount: 0,
      eventAction: 'synchronize',
      ownReviewBodies: [priorNoIssues],
      openThreadsRemain: false,
    });
    expect(decision).toEqual({ action: 'skip', reason: 'already-no-issues' });
  });

  test('DOES re-post no-issues if a real finding review came AFTER the last note', () => {
    const priorNoIssues = buildNoIssuesPayload({ deepInfo: {} }).body;
    // chronological: an old no-issues note, then a later findings review → newest
    // is NOT the no-issues note, so a fresh affirmative note is warranted.
    const laterFindingsReview = '## 🔭 thunder-deep-review (advisory)\nsome finding <!-- thunder-finding-hash:abc123 -->';
    const decision = decideTerminalAction({
      findingCount: 0,
      eventAction: 'synchronize',
      ownReviewBodies: [priorNoIssues, laterFindingsReview],
      openThreadsRemain: false,
    });
    expect(decision.action).toBe('no-issues');
  });

  test('does NOT post no-issues while a prior thread stays OPEN (would contradict it)', () => {
    // The gate dropped every candidate this run (findingCount 0), but a prior
    // thread's flagged code is unchanged so it stayed open. Posting "no issues"
    // alongside an open thread is contradictory → skip.
    const decision = decideTerminalAction({
      findingCount: 0,
      eventAction: 'synchronize',
      ownReviewBodies: [],
      openThreadsRemain: true,
    });
    expect(decision).toEqual({ action: 'skip', reason: 'open-threads-remain' });
  });

  test('reopened event suppresses the affirmative note (ambiguous base)', () => {
    const decision = decideTerminalAction({
      findingCount: 0,
      eventAction: 'reopened',
      ownReviewBodies: [],
      openThreadsRemain: false,
    });
    expect(decision).toEqual({ action: 'skip', reason: 'reopened-no-findings' });
  });
});

// ---------------------------------------------------------------------------
// SCENARIO 2 — gate KEEPS a subset: only that subset posts inline.
// ---------------------------------------------------------------------------

describe('gate-keeps-subset: only the kept subset posts inline', () => {
  test('terminal action is post-findings (and open threads are irrelevant here)', () => {
    const decision = decideTerminalAction({
      findingCount: 1,
      eventAction: 'synchronize',
      ownReviewBodies: [],
      openThreadsRemain: true,
    });
    expect(decision.action).toBe('post-findings');
  });

  test('ONLY the kept candidate becomes an inline comment', () => {
    const diffIndex = parseUnifiedDiff(DIFF);
    // The gate kept ONLY the blocker; the nit was dropped upstream, so it never
    // reaches the orchestrator. The kept subset must be exactly what posts.
    const kept = classifyFindings([blockerCandidate], diffIndex);
    const toPost = selectFindingsToPost(kept, noPrior);
    const payload = buildReviewPayload({ toPost, diffIndex, deepInfo: {} });
    expect(payload.comments.length).toBe(1);
    expect(payload.comments[0].path).toBe('src/a.ts');
    expect(payload.comments[0].line).toBe(2);
    expect(payload.comments[0].body).toContain('Unsafe call');
    expect(payload.comments[0].body).not.toContain('Style nit'); // dropped nit never appears
  });

  test('dedup drops a kept finding already open as our own thread', () => {
    const diffIndex = parseUnifiedDiff(DIFF);
    const kept = classifyFindings([blockerCandidate], diffIndex);
    const openHashes = new Set(kept.map((f) => f.hash));
    const toPost = selectFindingsToPost(kept, { ...noPrior, openHashes });
    expect(toPost.length).toBe(0); // already open as our thread → not re-posted
    const payload = buildReviewPayload({ toPost, diffIndex, deepInfo: {} });
    expect(payload.comments.length).toBe(0);
  });
});

test('summarizedHashesFromBodies collects every stamped hash across bodies', () => {
  const bodies = [
    'note <!-- thunder-finding-hash:aaaa1111 -->',
    'other <!-- thunder-finding-hash:bbbb2222 --> and <!-- thunder-finding-hash:cccc3333 -->',
  ];
  const set = summarizedHashesFromBodies(bodies);
  expect([...set].sort()).toEqual(['aaaa1111', 'bbbb2222', 'cccc3333']);
});

// ---------------------------------------------------------------------------
// Finding identity remains stable across prose and neighboring-line changes.
// ---------------------------------------------------------------------------

// A hunk whose offending line is the bare `}` — the canonical short/common token.
const SHORT_LINE_DIFF = [
  'diff --git a/src/x.ts b/src/x.ts',
  '--- a/src/x.ts',
  '+++ b/src/x.ts',
  '@@ -1,1 +1,4 @@',
  ' const head = 1;',
  '+const total = scaleByFactor(rawInput);',
  '+return total;',
  '+}',
].join('\n');

const shortLineFinding = (diff) =>
  classifyFindings([inlineFinding({ file: 'src/x.ts', line: 4 })], parseUnifiedDiff(diff))[0];

describe('finding identity: short/common offending line', () => {
  test('a `}` line gets a DISTINCTIVE multi-line window, not the bare token', () => {
    const f = shortLineFinding(SHORT_LINE_DIFF);
    expect(f.placement).toBe('inline');
    expect(f.livenessKey).toContain('scaleByFactor(rawInput)'); // pulled in real context
    expect(f.livenessKey).not.toBe('}'); // never the bare common token
  });

  test('a BLANK offending line anchors on the file path, not a window rooted on emptiness', () => {
    const blankDiff = ['diff --git a/src/b.ts b/src/b.ts', '+++ b/src/b.ts', '@@ -1,1 +1,2 @@', ' const x = 1;', '+'].join('\n');
    const f = classifyFindings([inlineFinding({ file: 'src/b.ts', line: 2 })], parseUnifiedDiff(blankDiff))[0];
    expect(f.placement).toBe('inline');
    expect(f.livenessKey).toBe('src/b.ts'); // file-path fallback — never '' or a '\n'-only key
  });

});

describe('finding identity: distinctive offending line', () => {
  const DISTINCT_DIFF = [
    'diff --git a/src/a.ts b/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,1 +1,2 @@',
    ' const a = 1;',
    '+const danger = useUnsafe(secretToken);',
  ].join('\n');
  const f = classifyFindings([inlineFinding({ file: 'src/a.ts', line: 2 })], parseUnifiedDiff(DISTINCT_DIFF))[0];

  test('distinctive line is a SINGLE-line key, stable across a neighbour change', () => {
    const withNeighbour = [
      'diff --git a/src/a.ts b/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,1 +1,3 @@',
      ' const a = 1;',
      '+const danger = useUnsafe(secretToken);',
      '+const unrelatedNeighbour = 99;',
    ].join('\n');
    const f2 = classifyFindings([inlineFinding({ file: 'src/a.ts', line: 2 })], parseUnifiedDiff(withNeighbour))[0];
    expect(f.livenessKey).not.toContain('\n'); // distinctive → no window needed
    expect(f.hash).toBe(f2.hash); // neighbour churn must NOT drift the dedup hash
  });

  test('prose/title drift must NOT drift the hash', () => {
    const reworded = classifyFindings(
      [inlineFinding({ file: 'src/a.ts', line: 2, title: 'COMPLETELY DIFFERENT TITLE', body: 'reworded prose' })],
      parseUnifiedDiff(DISTINCT_DIFF),
    )[0];
    expect(reworded.hash).toBe(f.hash); // only file+rule+severity+livenessKey feed the hash
  });

});

test('file-level and degenerate evidence windows retain file-path dedup keys', () => {
  const fileLevel = classifyFindings([inlineFinding({ file: 'src/x.ts', line: 999 })], parseUnifiedDiff(SHORT_LINE_DIFF))[0];
  expect(fileLevel.placement).toBe('file');
  expect(fileLevel.livenessKey).toBe('src/x.ts');
  const loneBrace = 'diff --git a/src/x.ts b/src/x.ts\n--- /dev/null\n+++ b/src/x.ts\n@@ -0,0 +1,1 @@\n+}';
  const degenerate = classifyFindings([inlineFinding({ file: 'src/x.ts', line: 1 })], parseUnifiedDiff(loneBrace))[0];
  expect(degenerate.placement).toBe('inline');
  expect(degenerate.livenessKey).toBe('src/x.ts');
});

describe('migration: re-key path never throws and re-posts once', () => {
  test('a legacy thread whose issue is re-flagged re-keys under a NEW windowed hash (dedup does not suppress it)', () => {
    const f = shortLineFinding(SHORT_LINE_DIFF); // fresh windowed hash this run
    // The pre-existing legacy thread for the SAME issue carries an OLD-format hash
    // and no key. Its hash differs from the new windowed hash, so the open-thread
    // dedup does NOT suppress the re-post — the finding re-keys exactly once.
    const legacyOpenHashes = new Set(['legacy-old-format-hash']);
    const toPost = selectFindingsToPost([f], {
      openHashes: legacyOpenHashes,
      humanResolvedHashes: new Set(),
      summarizedHashes: new Set(),
    });
    expect(toPost.map((x) => x.hash)).toEqual([f.hash]); // re-posts under the new key
    expect(legacyOpenHashes.has(f.hash)).toBe(false); // proves the hashes differ
  });

});

// ---------------------------------------------------------------------------
// SCENARIO 6 — diff reconstruction from the List-pull-request-files API. The
// `.diff` media type 406s past 20k lines, so the orchestrator rebuilds the diff
// from per-file `patch` bodies. These prove the rebuilt diff round-trips through
// parseUnifiedDiff into the SAME (path, line, side) anchors a real v3.diff yields.
// ---------------------------------------------------------------------------

// A files-API `patch` is the HUNK BODY ONLY — no `diff --git`/`---`/`+++` headers.
const MODIFIED_PATCH = ['@@ -1,1 +1,2 @@', ' const a = 1;', '+const danger = useUnsafe();'].join('\n');

describe('buildUnifiedDiff: reconstruct a git diff from /pulls/{n}/files entries', () => {
  test('a modified file gets the git headers so its added line is commentable', () => {
    const patch = buildUnifiedDiff([{ filename: 'src/a.ts', status: 'modified', patch: MODIFIED_PATCH, additions: 1, deletions: 0 }]);
    expect(patch).toContain('diff --git a/src/a.ts b/src/a.ts');
    expect(patch).toContain('--- a/src/a.ts');
    expect(patch).toContain('+++ b/src/a.ts');
    // Round-trip: the added line (right line 2) must be anchorable inline.
    const f = classifyFindings([inlineFinding({ file: 'src/a.ts', line: 2 })], parseUnifiedDiff(patch))[0];
    expect(f.placement).toBe('inline');
  });

  test('an added file uses --- /dev/null as the from-side', () => {
    const patch = buildUnifiedDiff([{ filename: 'src/new.ts', status: 'added', patch: ['@@ -0,0 +1,1 @@', '+const x = born();'].join('\n'), additions: 1, deletions: 0 }]);
    expect(patch).toContain('diff --git a/src/new.ts b/src/new.ts');
    expect(patch).toContain('--- /dev/null');
    expect(patch).toContain('+++ b/src/new.ts');
    expect(classifyFindings([inlineFinding({ file: 'src/new.ts', line: 1 })], parseUnifiedDiff(patch))[0].placement).toBe('inline');
  });

  test('a removed file uses +++ /dev/null and is NOT anchorable at head', () => {
    const patch = buildUnifiedDiff([{ filename: 'src/gone.ts', status: 'removed', patch: ['@@ -1,1 +0,0 @@', '-const x = dead();'].join('\n'), additions: 0, deletions: 1 }]);
    expect(patch).toContain('--- a/src/gone.ts');
    expect(patch).toContain('+++ /dev/null');
    // parseUnifiedDiff drops a /dev/null head side → the file has no RIGHT-side
    // commentable lines, so a finding on it demotes to a summary (parity with v3.diff).
    expect(parseUnifiedDiff(patch).has('src/gone.ts')).toBe(false);
  });

  test('a renamed file anchors the old path on the from-side', () => {
    const patch = buildUnifiedDiff([{ filename: 'src/new-name.ts', previous_filename: 'src/old-name.ts', status: 'renamed', patch: MODIFIED_PATCH, additions: 1, deletions: 0 }]);
    expect(patch).toContain('diff --git a/src/old-name.ts b/src/new-name.ts');
    expect(patch).toContain('--- a/src/old-name.ts');
    expect(patch).toContain('+++ b/src/new-name.ts');
  });

  test('a file with no patch (binary / large lockfile) is a header-only section', () => {
    const patch = buildUnifiedDiff([{ filename: 'bun.lock', status: 'modified', patch: undefined, additions: 422, deletions: 5 }]);
    expect(patch).toContain('diff --git a/bun.lock b/bun.lock');
    expect(patch).not.toContain('@@'); // no hunks → nothing to anchor
    expect(parseUnifiedDiff(patch).has('bun.lock')).toBe(false);
  });

  test('multiple files concatenate into one parseable diff', () => {
    const patch = buildUnifiedDiff([
      { filename: 'src/a.ts', status: 'modified', patch: MODIFIED_PATCH, additions: 1, deletions: 0 },
      { filename: 'bin.wasm', status: 'added', patch: undefined, additions: 0, deletions: 0 },
      { filename: 'src/b.ts', status: 'added', patch: ['@@ -0,0 +1,1 @@', '+const b = make();'].join('\n'), additions: 1, deletions: 0 },
    ]);
    const index = parseUnifiedDiff(patch);
    expect([...index.keys()]).toEqual(['src/a.ts', 'src/b.ts']); // the binary contributes no hunk
  });
});

// ---------------------------------------------------------------------------
// SCENARIO 7 — the deterministic deep-mode gate over the fetched file list.
// ---------------------------------------------------------------------------

describe('computeDeepMode: size gate + bounded-mode flag', () => {
  const file = (additions) => ({ additions, deletions: 0 });

  test.each([
    ['markdown', 'backend/drizzle/README.md'],
    ['MDX', 'src/crypto/guide.mdx'],
    ['docs tree', 'docs/example.ts'],
    ['bun lockfile', 'src/crypto/bun.lock'],
    ['other lockfiles', 'backend/drizzle/Cargo.lock'],
    ['npm lockfile', 'src/crypto/package-lock.json'],
    ['locale catalogs', 'src/crypto/messages.po'],
    ['compiled locale catalogs', 'src/crypto/locales/en/messages.ts'],
  ])('%s does not contribute to deep or security mode', (_rule, filename) => {
    const files = Array.from({ length: 40 }, () => ({ filename, additions: 600, deletions: 10 }));
    const info = computeDeepMode(files, false);
    expect(info.deepMode).toBe(false);
    expect(info.securityMode).toBe(false);
    expect(info.fileCount).toBe(0);
    expect(info.changedLines).toBe(0);
    expect(info.totalFileCount).toBe(40); // docs still form a real reviewable diff
    expect(info.sensitiveFiles).toEqual([]);
  });

  test('code still triggers at exactly 600 changed lines or 40 files', () => {
    expect(computeDeepMode([{ filename: 'src/app.tsx', additions: 300, deletions: 300 }], false).deepMode).toBe(true);
    expect(computeDeepMode(Array.from({ length: 40 }, () => file(1)), false).deepMode).toBe(true);
  });

  test('executable Markdown prompts contribute to deep mode', () => {
    for (const filename of ['.claude/skills/review/SKILL.md', '.claude/agents/reviewer.md', 'AGENTS.md', 'CLAUDE.md']) {
      const info = computeDeepMode([{ filename, additions: 600, deletions: 0 }], false);
      expect(info.deepMode).toBe(true);
      expect(info.fileCount).toBe(1);
      expect(info.changedLines).toBe(600);
    }
  });

  test('a small diff stays single-pass', () => {
    const info = computeDeepMode([file(10), file(20)], false);
    expect(info.deepMode).toBe(false);
    expect(info.changedLines).toBe(30);
    expect(info.boundedMode).toBe(false);
    expect(info.reason).toBe('default single fan-out');
  });

  test('crossing the changed-line threshold triggers deep mode', () => {
    const info = computeDeepMode([file(700)], false);
    expect(info.deepMode).toBe(true);
    expect(info.reason).toBe('size gate');
  });

  test('the 3000-file truncation flag flips bounded mode independently of the size gate', () => {
    const info = computeDeepMode([file(1)], true);
    expect(info.boundedMode).toBe(true); // driven by the truncation flag…
    expect(info.deepMode).toBe(false); // …not coupled to deep mode (a real truncation also trips the file-count gate)
  });

  test('a diff with no crypto paths leaves securityMode off', () => {
    const info = computeDeepMode([{ filename: 'src/app.tsx', additions: 5, deletions: 0 }], false);
    expect(info.securityMode).toBe(false);
    expect(info.sensitiveFiles).toEqual([]);
  });

  test('a tiny crypto-path diff trips securityMode WITHOUT deep mode', () => {
    const info = computeDeepMode([{ filename: 'backend/src/lib/canary.ts', additions: 1, deletions: 0 }], false);
    expect(info.securityMode).toBe(true); // security lane is independent of size…
    expect(info.deepMode).toBe(false); // …a one-line change is not deep mode
    expect(info.sensitiveFiles).toEqual(['backend/src/lib/canary.ts']);
  });

  test('sensitiveFiles lists only the crypto-path subset of a mixed diff', () => {
    const info = computeDeepMode(
      [
        { filename: 'src/app.tsx', additions: 3, deletions: 0 },
        { filename: 'src/crypto/primitives.ts', additions: 2, deletions: 1 },
        { filename: 'backend/drizzle/0042_x.sql', additions: 4, deletions: 0 },
      ],
      false,
    );
    expect(info.securityMode).toBe(true);
    expect(info.sensitiveFiles).toEqual(['src/crypto/primitives.ts', 'backend/drizzle/0042_x.sql']);
  });
});

// ---------------------------------------------------------------------------
// SCENARIO 7b — matchesSecurityPath: the crypto/E2EE path predicate that drives
// the path-conditional security dimension. Glob-prefixes vs exact files.
// ---------------------------------------------------------------------------

describe('summarizeExecution: aggregate SDK events without content', () => {
  const agent = (id, name, subagentType) => ({
    type: 'assistant', message: { content: [
      { type: 'text', text: 'PRIVATE MESSAGE' },
      { type: 'tool_use', id, name, input: { subagent_type: subagentType, prompt: 'PRIVATE PROMPT' } },
    ] },
  });
  const usage = { costUSD: 1, inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40 };

  test('reports whole-tree modelUsage from the final result and unique Agent/Task calls by type', () => {
    const events = [
      { type: 'result', total_cost_usd: 1, num_turns: 1 },
      agent('a', 'Agent', 'powersync-sync-reviewer'),
      agent('a', 'Agent', 'powersync-sync-reviewer'), // SDK can repeat blocks
      agent('b', 'Task', 'powersync-sync-reviewer'),
      agent('c', 'Agent', 'general-purpose'),
      agent('d', 'Read', 'ignored'),
      { type: 'result', subtype: 'success', total_cost_usd: 2, num_turns: 9, result: 'PRIVATE RESULT',
        usage: { input_tokens: 999 }, modelUsage: { 'claude-opus-4-8': usage, 'claude-sonnet-4-6': usage } },
    ];
    const summary = summarizeExecution(events);
    expect(summary).toEqual({
      costUsd: 2, turns: 9,
      models: {
        'claude-opus-4-8': { costUsd: 1, input: 10, output: 20, cacheRead: 30, cacheCreation: 40 },
        'claude-sonnet-4-6': { costUsd: 1, input: 10, output: 20, cacheRead: 30, cacheCreation: 40 },
      },
      agentCalls: { 'powersync-sync-reviewer': 2, 'general-purpose': 1 },
    });
    expect(JSON.stringify(summary)).not.toContain('PRIVATE');
  });

  test('error results retain metrics; missing results do not fabricate zero spend', () => {
    expect(summarizeExecution([{ type: 'result', subtype: 'error_max_turns', total_cost_usd: 3, num_turns: 40 }]))
      .toEqual({ costUsd: 3, turns: 40, models: {}, agentCalls: {} });
    expect(summarizeExecution([agent('a', 'Agent', 'general-purpose')]))
      .toEqual({ costUsd: null, turns: null, models: {}, agentCalls: { 'general-purpose': 1 } });
    expect(summarizeExecution([])).toEqual({ costUsd: null, turns: null, models: {}, agentCalls: {} });
  });

  test('whitelists numeric fields and identifier labels before logging', () => {
    const summary = summarizeExecution([
      agent('a', 'Task', 'PRIVATE\n::error::content'),
      { type: 'result', total_cost_usd: 'PRIVATE', num_turns: -1,
        modelUsage: { 'PRIVATE\n::error::content': { ...usage, inputTokens: 'PRIVATE', outputTokens: Infinity, secret: 'PRIVATE' } } },
    ]);
    expect(summary.models.unknown).toEqual({ costUsd: 1, input: null, output: null, cacheRead: 30, cacheCreation: 40 });
    expect(summary.agentCalls).toEqual({ unknown: 1 });
    expect(summary.costUsd).toBeNull();
    expect(summary.turns).toBeNull();
    expect(JSON.stringify(summary)).not.toContain('PRIVATE');
  });

  test('preserves distinct model ids with context-window suffixes', () => {
    const summary = summarizeExecution([{ type: 'result', modelUsage: {
      'claude-opus-4-8[1m]': usage,
      'claude-sonnet-4-6[1m]': { ...usage, inputTokens: 50 },
    } }]);
    expect(summary.models['claude-opus-4-8[1m]'].input).toBe(10);
    expect(summary.models['claude-sonnet-4-6[1m]'].input).toBe(50);
    expect(Object.keys(summary.models)).toHaveLength(2);
  });
});

describe('telemetry phase', () => {
  /** Exercise the phase directly with isolated execution logs and no GitHub credentials. */
  const runTelemetry = (raw, outcome = 'success', explicitPath = true) => {
    const directory = mkdtempSync(join(tmpdir(), 'thunder-telemetry-'));
    const file = join(directory, 'claude-execution-output.json');
    try {
      if (raw !== null) writeFileSync(file, raw);
      return spawnSync('node', [fileURLToPath(new URL('./review-orchestrator.mjs', import.meta.url)), 'telemetry'], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, RUNNER_TEMP: directory, EXECUTION_FILE: explicitPath ? file : '', MODEL_OUTCOME: outcome },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };

  test('emits aggregates from the runner-temp fallback even after a model error', () => {
    const raw = JSON.stringify([{ type: 'result', subtype: 'error_max_turns', total_cost_usd: 4, num_turns: 40,
      result: 'PRIVATE', modelUsage: { 'claude-opus-4-8': {
        costUSD: 4, inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4,
      } } }]);
    const output = runTelemetry(raw, 'failure', false);
    expect(output.status).toBe(0);
    expect(JSON.parse(output.stdout).costUsd).toBe(4);
    expect(output.stderr).toBe('');
    expect(output.stdout).not.toContain('PRIVATE');
  });

  test('absent execution files warn without failing', () => {
    const output = runTelemetry(null);
    expect(output.status).toBe(0);
    expect(output.stdout).toBe('');
    expect(output.stderr).toContain('::warning::Claude execution file absent');
  });

  test('malformed execution logs warn without exposing their contents', () => {
    const output = runTelemetry('PRIVATE invalid JSON');
    expect(output.status).toBe(0);
    expect(output.stderr).toContain('::warning::Could not aggregate');
    expect(output.stderr + output.stdout).not.toContain('PRIVATE');
  });

  test('skipped gate telemetry does not reuse an existing recall log', () => {
    const output = runTelemetry('[{"type":"result","total_cost_usd":999,"num_turns":999}]', 'skipped');
    expect(output.status).toBe(0);
    expect(output.stdout).toBe('');
    expect(output.stderr).toContain('::warning::Model step skipped');
  });
});

describe('matchesSecurityPath: crypto/E2EE path predicate', () => {
  test('matches the glob-prefixed crypto trees', () => {
    expect(matchesSecurityPath('src/crypto/key-storage.ts')).toBe(true);
    expect(matchesSecurityPath('src/db/encryption/codec.ts')).toBe(true);
    expect(matchesSecurityPath('backend/drizzle/meta/_journal.json')).toBe(true);
    expect(matchesSecurityPath('scripts/org-escrow-decrypt.ts')).toBe(true);
  });

  // Every entry names a file that EXISTS. The list previously carried
  // `backend/src/lib/org-escrow.ts`, which never has — a dead matcher that made
  // the list look complete while the security lane skipped the real surface.
  test('matches the exact sensitive files', () => {
    expect(matchesSecurityPath('backend/src/api/encryption.ts')).toBe(true);
    expect(matchesSecurityPath('backend/src/api/powersync.ts')).toBe(true);
    expect(matchesSecurityPath('backend/src/lib/canary.ts')).toBe(true);
    expect(matchesSecurityPath('backend/src/lib/device-bind.ts')).toBe(true);
    expect(matchesSecurityPath('backend/src/lib/encrypted-payload.ts')).toBe(true);
    expect(matchesSecurityPath('backend/src/lib/step-up-otp.ts')).toBe(true);
    expect(matchesSecurityPath('shared/e2ee-types.ts')).toBe(true);
    expect(matchesSecurityPath('src/services/encryption.ts')).toBe(true);
    expect(matchesSecurityPath('src/db/powersync/middleware/EncryptionMiddleware.ts')).toBe(true);
  });

  test('does not match adjacent non-crypto paths or a bare prefix', () => {
    expect(matchesSecurityPath('src/app.tsx')).toBe(false);
    expect(matchesSecurityPath('backend/src/lib/http.ts')).toBe(false); // sibling of canary/device-bind
    expect(matchesSecurityPath('backend/src/api/encryptionX.ts')).toBe(false); // exact-match only
    expect(matchesSecurityPath('src/cryptography/x.ts')).toBe(false); // not the src/crypto/ tree
    expect(matchesSecurityPath('scripts/create-release.ts')).toBe(false); // not an org-escrow script
  });

  test('tolerates a non-string filename (undefined from a malformed file entry)', () => {
    expect(matchesSecurityPath(undefined)).toBe(false);
    expect(matchesSecurityPath(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SCENARIO 8 — diff-availability guard: a failed Files API fetch (empty diff)
// must NOT launder into a false affirmative "no issues" review.
// ---------------------------------------------------------------------------

describe('decideTerminalAction: never affirms no-issues without a diff', () => {
  const clean = { findingCount: 0, eventAction: 'synchronize', ownReviewBodies: [], openThreadsRemain: false };

  test('skips with reason diff-unavailable when no diff was fetched', () => {
    expect(decideTerminalAction({ ...clean, diffAvailable: false })).toEqual({ action: 'skip', reason: 'diff-unavailable' });
  });

  test('still affirms no-issues on a real (available) clean diff', () => {
    expect(decideTerminalAction({ ...clean, diffAvailable: true }).action).toBe('no-issues');
  });

  test('defaults to available (no behavior change for callers that omit it)', () => {
    expect(decideTerminalAction(clean).action).toBe('no-issues');
  });

  test('a diff-unavailable run with findings still posts them (does not silently drop)', () => {
    expect(decideTerminalAction({ ...clean, findingCount: 2, diffAvailable: false }).action).toBe('post-findings');
  });
});

// ---------------------------------------------------------------------------
// SCENARIO 9 — normalizeFindings: the model-output trust boundary, now covering
// the internal precision-gate fields (confidence/evidence) alongside the
// pre-existing severity/line rules that moved into the extracted function.
// ---------------------------------------------------------------------------

describe('normalizeFindings: confidence + evidence normalization', () => {
  // Wrap a single finding through the parsed-JSON shape the model emits.
  const normalizeOne = (over) => normalizeFindings({ findings: [{ ...blockerCandidate, ...over }] });

  test("confidence 'HIGH' lowercases to 'high' and the finding survives", () => {
    const [f] = normalizeOne({ confidence: 'HIGH' });
    expect(f.confidence).toBe('high');
    expect(f.title).toBe('Unsafe call');
  });

  test('out-of-enum or missing confidence → null WITHOUT dropping the finding', () => {
    const [certain] = normalizeOne({ confidence: 'certain' });
    expect(certain.confidence).toBeNull();
    const [missing] = normalizeOne({});
    expect(missing.confidence).toBeNull();
    expect(missing.title).toBe('Unsafe call'); // the finding itself survives
  });

  test('evidence round-trips as a string and is capped at 1000 chars', () => {
    const [f] = normalizeOne({ evidence: 'const x = 1;' });
    expect(f.evidence).toBe('const x = 1;');
    const [long] = normalizeOne({ evidence: 'e'.repeat(2000) });
    expect(long.evidence).toBe('e'.repeat(1000));
  });

  test('empty or non-string evidence → null', () => {
    expect(normalizeOne({ evidence: '' })[0].evidence).toBeNull();
    expect(normalizeOne({ evidence: '   ' })[0].evidence).toBeNull(); // whitespace-only = empty after trim
    expect(normalizeOne({ evidence: 42 })[0].evidence).toBeNull();
    expect(normalizeOne({})[0].evidence).toBeNull();
  });

  test('existing behaviors hold through the extraction: out-of-enum severity drops; line 0 → null', () => {
    expect(normalizeFindings({ findings: [{ ...blockerCandidate, severity: 'catastrophic' }] })).toEqual([]);
    const [f] = normalizeOne({ line: 0 });
    expect(f.line).toBeNull();
  });

  test("the security dimension's `critical` tier survives normalization (case-insensitive)", () => {
    const [lower] = normalizeOne({ severity: 'critical' });
    expect(lower.severity).toBe('critical');
    const [upper] = normalizeOne({ severity: 'CRITICAL' });
    expect(upper.severity).toBe('critical');
  });
});

// ---------------------------------------------------------------------------
// SCENARIO 10 — severity-invariant identity: the precision gate may DEMOTE a
// finding's severity (blocking→convention, convention→nit) and the recall model
// can drift it across runs. Identity must not re-key on either, or a demotion
// would post a duplicate comment for an issue that already has an open thread.
// ---------------------------------------------------------------------------

describe('severity-invariant identity: demotion never re-keys the thread', () => {
  const diffIndex = parseUnifiedDiff(DIFF);
  const classifyOne = (over) => classifyFindings([{ ...blockerCandidate, ...over }], diffIndex)[0];

  test('the SAME finding at blocking vs convention severity hashes identically', () => {
    const blocking = classifyOne({ severity: 'blocking' });
    const demoted = classifyOne({ severity: 'convention' });
    expect(demoted.hash).toBe(blocking.hash);
  });

  test('a critical→blocking demotion keeps the same hash (the tier is not hashed)', () => {
    const critical = classifyOne({ severity: 'critical' });
    const demoted = classifyOne({ severity: 'blocking' });
    expect(demoted.hash).toBe(critical.hash);
  });

  test('run 2 emitting the DEMOTED variant of an open thread posts nothing', () => {
    // Run 1 posted the blocking variant → its hash is an open own-thread.
    const blocking = classifyOne({ severity: 'blocking' });
    const openHashes = new Set([blocking.hash]);
    // Run 2: the gate demoted the same finding to convention. Same hash → deduped.
    const demoted = classifyOne({ severity: 'convention' });
    const toPost = selectFindingsToPost([demoted], { ...noPrior, openHashes });
    expect(toPost).toEqual([]); // no duplicate post after demotion
  });

  test('confidence/evidence differences never affect the hash', () => {
    const a = classifyOne({ confidence: 'high', evidence: 'const danger = useUnsafe();' });
    const b = classifyOne({ confidence: 'low', evidence: 'a totally different quote' });
    const c = classifyOne({}); // no internal fields at all
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toBe(c.hash);
  });
});

// ---------------------------------------------------------------------------
// SCENARIO 11 — internal fields never reach human-facing output: confidence and
// evidence are precision-gate grounding only, so neither an inline comment body
// nor a summary bullet may leak them.
// ---------------------------------------------------------------------------

describe('internal fields never reach human-facing output', () => {
  // Distinctive marker that appears NOWHERE in the DIFF fixture — the liveness
  // key derives from the DIFF's code, not from evidence, so this string can only
  // reach the payload if evidence itself leaked into the rendering.
  const SECRET = 'const SECRET_EVIDENCE_MARKER = 42;';

  const payloadFor = (over) => {
    const diffIndex = parseUnifiedDiff(DIFF);
    const kept = classifyFindings(
      normalizeFindings({ findings: [{ ...blockerCandidate, confidence: 'low', evidence: SECRET, ...over }] }),
      diffIndex,
    );
    return { kept, payload: buildReviewPayload({ toPost: selectFindingsToPost(kept, noPrior), diffIndex, deepInfo: {} }) };
  };

  test('inline comment body contains neither the evidence string nor "confidence"', () => {
    const { payload } = payloadFor({});
    expect(payload.comments.length).toBe(1);
    expect(payload.comments[0].body).toContain('Unsafe call'); // the human-facing part is intact
    expect(payload.comments[0].body).not.toContain(SECRET);
    expect(payload.comments[0].body).not.toContain('confidence');
    expect(payload.body).not.toContain(SECRET); // nor the surrounding review body
  });

  test('summary-placement bullet in payload.body leaks neither field', () => {
    // File NOT in the diff → summary placement → rolled into the review body.
    const { kept, payload } = payloadFor({ file: 'src/not-in-diff.ts' });
    expect(kept[0].placement).toBe('summary');
    expect(payload.body).toContain(SUMMARY_HEADING); // the bullet actually rendered
    expect(payload.body).toContain('Unsafe call');
    expect(payload.body).not.toContain(SECRET);
    expect(payload.body).not.toContain('confidence');
  });
});
