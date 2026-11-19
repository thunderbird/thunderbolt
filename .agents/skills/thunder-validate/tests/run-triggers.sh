#!/usr/bin/env bash

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

set -euo pipefail

evalDir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
python3 - "$evalDir/triggers.json" "$@" <<'PY'
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys

parser = argparse.ArgumentParser(
    prog='run-triggers.sh',
    description=(
        'Claude Code trigger harness: asks `claude -p` which skill fits each case; does not run app QA. '
        'For another agent, send it the `prompt` text in this script plus each query from the cases JSON and '
        'compare its answer with should_trigger.'
    ),
)
parser.add_argument('--repo', type=Path, help='Repository directory (default: git toplevel of cwd)')
parser.add_argument('--file', type=Path, default=Path(sys.argv[1]), metavar='JSON',
                    help='Cases JSON (default: triggers.json beside this runner)')
parser.add_argument('--repeat', type=int, default=1, metavar='N', help='Run every case N times (default: 1)')
args = parser.parse_args(sys.argv[2:])
if args.repeat < 1:
    parser.error('--repeat must be a positive integer')
if args.repo is None:
    result = subprocess.run(['git', 'rev-parse', '--show-toplevel'], capture_output=True, text=True)
    if result.returncode != 0:
        parser.error('cwd is not in a git repository; pass --repo')
    args.repo = Path(result.stdout.strip())
if not args.repo.is_dir():
    parser.error('--repo must be an existing directory')
if shutil.which('claude') is None:
    parser.error('claude must be available on PATH')

cases = json.loads(args.file.read_text())
prompt = (
    'Answer directly from the skills listed in your context without calling any tools. '
    'Which installed skill, by exact name, would you invoke to handle this request? '
    'Reply with only the skill name, or NONE if no skill fits. Do not do the task. Request: '
)
counts = {'PASS': 0, 'FAIL': 0, 'ERROR': 0}
for repetition in range(1, args.repeat + 1):
    for index, case in enumerate(cases, 1):
        for attempt in range(1, 3):
            result = subprocess.run(
                ['claude', '-p', prompt + case['query'], '--max-turns', '1'],
                cwd=args.repo, capture_output=True, text=True,
            )
            answer = result.stdout.strip()
            inconclusive = (
                result.returncode != 0 or not answer
                or 'Reached max turns' in result.stdout
                or 'Reached max turns' in result.stderr
            )
            if not inconclusive or attempt == 2:
                break
            print(
                f'ERROR (inconclusive) repeat {repetition}/{args.repeat} '
                f'case {index}/{len(cases)}; retrying once',
                flush=True,
            )
        if inconclusive:
            verdict = 'ERROR'
        else:
            matches = (answer == 'thunder-validate') == case['should_trigger']
            verdict = 'PASS' if matches else 'FAIL'
        counts[verdict] += 1
        expectation = 'thunder-validate' if case['should_trigger'] else 'anything except thunder-validate'
        print(
            f'{verdict} repeat {repetition}/{args.repeat} '
            f'case {index}/{len(cases)}: {json.dumps(case["query"], ensure_ascii=False)} '
            f'expected={expectation}; got={json.dumps(answer, ensure_ascii=False)}; '
            f'exit={result.returncode}; attempts={attempt}',
            flush=True,
        )
total = len(cases) * args.repeat
print(f'PASS: {counts["PASS"]}; FAIL: {counts["FAIL"]}; ERROR: {counts["ERROR"]}; total: {total}')
sys.exit(1 if counts['FAIL'] or counts['ERROR'] else 0)
PY
