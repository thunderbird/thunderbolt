#!/usr/bin/env bash

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

set -euo pipefail
# Input: --log PATH or BACKEND_LOG; --marks PATH optional. Output: safe event fields.
python3 - "$@" <<'PY'
import argparse,hashlib,json,os,pathlib,re,sys
p=argparse.ArgumentParser(description='Mark backend log boundaries and extract proxy_request method target_host status.',epilog='Usage: bash log-marks.sh [--log PATH] [--marks PATH] mark LABEL | events FROM [TO]. Defaults: BACKEND_LOG and <log>.marks.json. mark writes only boundary metadata; events is read-only. Detects rotation/truncation; never emits raw logs.')
p.add_argument('--log',default=os.environ.get('BACKEND_LOG'));p.add_argument('--marks')
sub=p.add_subparsers(dest='command',required=True)
sub.add_parser('mark').add_argument('label')
events=sub.add_parser('events');events.add_argument('start');events.add_argument('end',nargs='?')
a=p.parse_args()
if not a.log:p.error('Set BACKEND_LOG or provide --log PATH')
log=pathlib.Path(a.log);marks=pathlib.Path(a.marks or str(log)+'.marks.json')
try:
    raw=log.read_bytes();stat=log.stat()
    data=json.loads(marks.read_text()) if marks.exists() else {}
    if a.command=='mark':
        if not re.fullmatch(r'[A-Za-z0-9_-]+',a.label):p.error('Labels may contain letters, digits, underscore, hyphen')
        if a.label in data:p.error('Label exists; use a unique action label to preserve earlier evidence')
        if raw and not raw.endswith(b'\n'):p.error('Log has an unfinished line; wait for a complete event before marking')
        data[a.label]={'device':stat.st_dev,'inode':stat.st_ino,'offset':len(raw),'lines':raw.count(b'\n'),'digest':hashlib.sha256(raw).hexdigest()}
        marks.write_text(json.dumps(data,indent=2)+'\n')
        print(f'{a.label}: line {data[a.label]["lines"]}, byte {len(raw)}');sys.exit(0)
    def boundary(label):
        if label not in data:p.error('Unknown mark; create it with mark LABEL first')
        m=data[label];n=m['offset']
        if (m['device'],m['inode'])!=(stat.st_dev,stat.st_ino) or n>len(raw) or hashlib.sha256(raw[:n]).hexdigest()!=m['digest']:
            p.error('Log rotated, truncated, or changed; start a new marks file and repeat the action/control')
        return n
    lo=boundary(a.start);hi=boundary(a.end) if a.end else len(raw)
    if hi<lo:p.error('End mark precedes start mark')
    text=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',raw[lo:hi].decode(errors='replace'))
    markers=list(re.finditer(r'''["']?event["']?\s*:\s*["']?([a-z_]+)''',text))
    count=0
    for i,m in enumerate(markers):
        if m.group(1)!='proxy_request':continue
        block=text[m.end():markers[i+1].start() if i+1<len(markers) else len(text)]
        fields={}
        for name in ('method','target_host','status'):
            match=re.search(r'''["']?'''+name+r'''["']?\s*:\s*["']?([^\s,"'}]+)''',block)
            if not match:p.error('Incomplete proxy_request event at boundary; wait for flush and repeat with fresh marks')
            fields[name]=match.group(1)
        if not re.fullmatch(r'[A-Z]+',fields['method']) or not re.fullmatch(r'[A-Za-z0-9.\[\]:_-]+',fields['target_host']) or not re.fullmatch(r'\d{3}',fields['status']):
            p.error('Unexpected event format; inspect observability.ts privately and update the parser')
        print(fields['method'],fields['target_host'],fields['status']);count+=1
    print(f'{count} proxy_request event(s) between marks',file=sys.stderr)
except (OSError,ValueError,KeyError):
    print('Cannot read log/marks or invalid marks JSON; check paths and permissions. Raw contents suppressed.',file=sys.stderr);sys.exit(2)
PY
