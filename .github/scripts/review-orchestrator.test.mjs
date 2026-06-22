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

import { describe, test, expect } from 'bun:test';

import {
  parseUnifiedDiff,
  classifyFindings,
  selectFindingsToPost,
  decideTerminalAction,
  latestOwnReviewIsNoIssues,
  summarizedHashesFromBodies,
  buildReviewPayload,
  buildNoIssuesPayload,
  NO_ISSUES_MARKER,
} from './review-orchestrator.mjs';

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
    const payload = buildNoIssuesPayload({ deepInfo: { deepMode: false, boundedMode: false }, skipCount: 0 });
    expect(payload.event).toBe('COMMENT');
    expect(payload.comments.length).toBe(0); // affirmative note posts no inline comments
    expect(payload.body).toContain(NO_ISSUES_MARKER);
    expect(payload.body).toMatch(/no issues/i);
  });

  test('does NOT re-post when the latest own review is already no-issues', () => {
    const priorNoIssues = buildNoIssuesPayload({ deepInfo: {}, skipCount: 0 }).body;
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
    const priorNoIssues = buildNoIssuesPayload({ deepInfo: {}, skipCount: 0 }).body;
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
    const payload = buildReviewPayload({ toPost, diffIndex, deepInfo: {}, skipCount: 0 });
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
    const payload = buildReviewPayload({ toPost, diffIndex, deepInfo: {}, skipCount: 0 });
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
