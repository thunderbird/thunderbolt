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
  normalizeDiffText,
  classifyFindings,
  selectFindingsToPost,
  decideTerminalAction,
  latestOwnReviewIsNoIssues,
  summarizedHashesFromBodies,
  buildReviewPayload,
  buildNoIssuesPayload,
  shouldResolveThread,
  livenessKeyFromBody,
  livenessStamp,
  NO_ISSUES_MARKER,
} from './review-orchestrator.mjs';

// The diff-evidence sweep substring-tests a thread's liveness key against the
// NORMALIZED diff loadDiffIndex builds — reuse the production normalizer (not a
// mirror) so the tests can't silently desync from what the sweep actually sees.
const normalizedDiff = (patch) => normalizeDiffText(parseUnifiedDiff(patch));

// Build the own-thread record the sweep sees, the way fetchOwnThreads would after
// round-tripping a finding's stamp through a comment body (stamp → decode).
const threadFromFinding = (f) => ({
  isResolved: false,
  resolvedByLogin: null,
  hash: f.hash,
  livenessKey: livenessKeyFromBody(`x ${livenessStamp(f.livenessKey)}`),
});

const inlineFinding = (over) => ({
  severity: 'blocking',
  side: 'RIGHT',
  title: 't',
  body: 'b',
  rule: 'R',
  ...over,
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

// ---------------------------------------------------------------------------
// SCENARIO 3 — shouldResolveThread: the 4 convergence invariants.
//
// A "short/common" offending line (`}`, `return;`) has a trimmed key that is a
// substring of almost ANY diff, so the OLD bare-line rule pinned its thread open
// forever (never-resolve). The fix anchors on a distinctive WINDOW (offending line
// + neighbouring context), tested against the normalized diff. We prove:
//   I1  code GONE from the diff → resolves, even on an empty/all-clean run, even
//       for a short/common offending line.
//   I2  code STILL in the diff but the model missed it → STAYS OPEN (short/common
//       lines AND legacy threads): never a false-resolve on a recall miss.
//   I3  the dedup hash stays stable across pushes (no title/prose drift).
//   I4  a short/common line neither pins the thread open forever (I1) nor routes
//       to the bare recall-miss rule (I2).
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

describe('shouldResolveThread: short/common offending line', () => {
  test('I4: a `}` line gets a DISTINCTIVE multi-line window, not the bare token', () => {
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

  test('I2: stays OPEN while its windowed code is still in the diff (recall miss)', () => {
    const f = shortLineFinding(SHORT_LINE_DIFF);
    const thread = threadFromFinding(f);
    // The model returned other findings this run but MISSED this one — its code is
    // unchanged, so the window is still present and the thread must NOT resolve.
    expect(shouldResolveThread(thread, normalizedDiff(SHORT_LINE_DIFF))).toBe(false);
  });

  test('I2: a bare `}` is present in nearly every diff — the OLD rule would pin it; the window does not', () => {
    const f = shortLineFinding(SHORT_LINE_DIFF);
    // An UNRELATED later diff that no longer touches this code but still has a `}`.
    const unrelated = normalizedDiff(
      ['diff --git a/src/z.ts b/src/z.ts', '+++ b/src/z.ts', '@@ -1,1 +1,2 @@', ' const z = 1;', '+if (z) { doThing(); }'].join('\n'),
    );
    expect(unrelated).toContain('}'); // bare token present → old rule never resolves
    expect(shouldResolveThread(threadFromFinding(f), unrelated)).toBe(true); // window gone → resolves
  });

  test('I1: code GONE → resolves on an all-clean / empty run', () => {
    const f = shortLineFinding(SHORT_LINE_DIFF);
    const thread = threadFromFinding(f);
    expect(shouldResolveThread(thread, '')).toBe(true); // empty diff
    // And when the file is still touched but the offending window is fixed away:
    const fixed = normalizedDiff(
      ['diff --git a/src/x.ts b/src/x.ts', '+++ b/src/x.ts', '@@ -1,1 +1,2 @@', ' const head = 1;', '+const total = scaleSafely(rawInput);'].join('\n'),
    );
    expect(shouldResolveThread(thread, fixed)).toBe(true);
  });
});

describe('shouldResolveThread: distinctive offending line', () => {
  const DISTINCT_DIFF = [
    'diff --git a/src/a.ts b/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,1 +1,2 @@',
    ' const a = 1;',
    '+const danger = useUnsafe(secretToken);',
  ].join('\n');
  const f = classifyFindings([inlineFinding({ file: 'src/a.ts', line: 2 })], parseUnifiedDiff(DISTINCT_DIFF))[0];

  test('I3: distinctive line is a SINGLE-line key, stable across a neighbour change', () => {
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

  test('I3: prose/title drift must NOT drift the hash', () => {
    const reworded = classifyFindings(
      [inlineFinding({ file: 'src/a.ts', line: 2, title: 'COMPLETELY DIFFERENT TITLE', body: 'reworded prose' })],
      parseUnifiedDiff(DISTINCT_DIFF),
    )[0];
    expect(reworded.hash).toBe(f.hash); // only file+rule+severity+livenessKey feed the hash
  });

  test('keeps open while present, resolves when its code leaves the diff', () => {
    const thread = threadFromFinding(f);
    expect(shouldResolveThread(thread, normalizedDiff(DISTINCT_DIFF))).toBe(false);
    expect(shouldResolveThread(thread, '')).toBe(true);
  });
});

describe('shouldResolveThread: legacy (no stamped key) threads', () => {
  test('I2: NEVER false-resolves on a recall miss even when the run has OTHER findings (Bugbot r3454463237)', () => {
    // Legacy thread predates the liveness stamp → livenessKey is null. This run
    // produced other findings whose hashes differ from the legacy thread's. The
    // OLD fallback resolved it (findingCount > 0 && !currentHashes.has(hash)),
    // false-resolving a still-unfixed issue. It must now STAY OPEN.
    const legacy = { isResolved: false, resolvedByLogin: null, hash: 'deadbeefcafe', livenessKey: null };
    expect(shouldResolveThread(legacy, normalizedDiff(SHORT_LINE_DIFF))).toBe(false);
    expect(shouldResolveThread(legacy, '')).toBe(false); // not even on an empty run
  });

  test('already-resolved or hash-less threads are never touched', () => {
    expect(shouldResolveThread({ isResolved: true, hash: 'x', livenessKey: 'k' }, '')).toBe(false);
    expect(shouldResolveThread({ isResolved: false, hash: null, livenessKey: 'k' }, '')).toBe(false);
  });
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

  test('a corrupted/empty liveness stamp decodes to null and never throws (treated as legacy)', () => {
    expect(livenessKeyFromBody('body <!-- thunder-liveness: -->')).toBeNull();
    expect(livenessKeyFromBody('body with no stamp at all')).toBeNull();
    // `AAAA` is VALID base64 that decodes to NUL bytes — must be treated as absent,
    // not a key. Otherwise `!diff.includes('\0\0\0')` is always true → false-resolve.
    expect(livenessKeyFromBody('x <!-- thunder-liveness:AAAA -->')).toBeNull();
    // Round-trip a real key to confirm decode is the inverse of stamp.
    const f = shortLineFinding(SHORT_LINE_DIFF);
    expect(livenessKeyFromBody(`x ${livenessStamp(f.livenessKey)}`)).toBe(f.livenessKey);
  });

  test('a corrupted (NUL-byte) liveness key never false-resolves its thread', () => {
    const corrupt = livenessKeyFromBody('x <!-- thunder-liveness:AAAA -->'); // → null
    // null livenessKey = legacy path = never recall-miss resolve (not a key match).
    expect(shouldResolveThread({ isResolved: false, hash: 'h', livenessKey: corrupt }, 'const stillHere = 1;')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SCENARIO 4 — file-level findings + degenerate-hunk fallbacks resolve on the
// FILE leaving the diff, and never false-resolve while the file is present. The
// normalized diff emits each file's PATH as a row so the `file:<path>` key stays
// a valid substring; without that a file-level thread false-resolves every run.
// ---------------------------------------------------------------------------

describe('file-level + degenerate-window findings key on the file path', () => {
  const FILE_DIFF = [
    'diff --git a/src/foo.ts b/src/foo.ts',
    '+++ b/src/foo.ts',
    '@@ -1,1 +1,2 @@',
    ' const a = 1;',
    '+const realThing = compute();',
  ].join('\n');

  test('file-level finding (line not in diff) keys on the path and STAYS OPEN while the file is in the diff', () => {
    const f = classifyFindings([inlineFinding({ file: 'src/foo.ts', line: 999 })], parseUnifiedDiff(FILE_DIFF))[0];
    expect(f.placement).toBe('file');
    expect(f.livenessKey).toBe('src/foo.ts');
    // The file is still in the diff → path row is present → must NOT resolve.
    expect(shouldResolveThread(threadFromFinding(f), normalizedDiff(FILE_DIFF))).toBe(false);
  });

  test('file-level finding RESOLVES when its file leaves the diff (and on an empty run)', () => {
    const f = classifyFindings([inlineFinding({ file: 'src/foo.ts', line: 999 })], parseUnifiedDiff(FILE_DIFF))[0];
    const thread = threadFromFinding(f);
    const otherFile = normalizedDiff(['diff --git a/src/bar.ts b/src/bar.ts', '+++ b/src/bar.ts', '@@ -1,1 +1,2 @@', ' const b = 1;', '+y();'].join('\n'));
    expect(shouldResolveThread(thread, otherFile)).toBe(true);
    expect(shouldResolveThread(thread, '')).toBe(true);
  });

  test('a degenerate hunk (a lone `+}`, no distinctive window) falls back to the file path, not the bare `}`', () => {
    // A one-line added file: the only line is `}`. The window cannot grow to
    // distinctiveness, so it must fall back to the file path (which resolves when
    // the file leaves the diff) rather than pin the thread on `}` forever (BUG #1).
    const lone = ['diff --git a/src/one.ts b/src/one.ts', '--- /dev/null', '+++ b/src/one.ts', '@@ -0,0 +1,1 @@', '+}'].join('\n');
    const f = classifyFindings([inlineFinding({ file: 'src/one.ts', line: 1 })], parseUnifiedDiff(lone))[0];
    expect(f.livenessKey).toBe('src/one.ts'); // never the bare `}`
    // Against an UNRELATED diff that still has a `}`, the OLD bare key would pin it
    // open; the file-path key resolves because the file is gone.
    const unrelated = normalizedDiff(['diff --git a/src/z.ts b/src/z.ts', '+++ b/src/z.ts', '@@ -1,1 +1,2 @@', ' const z = 1;', '+if (z) { go(); }'].join('\n'));
    expect(shouldResolveThread(threadFromFinding(f), unrelated)).toBe(true);
  });
});
