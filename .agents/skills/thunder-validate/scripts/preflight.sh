#!/usr/bin/env bash

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

set -euo pipefail
# Inputs: --json, --repo PATH. Output: tool inventory. Side effects: none; no boot/install.
if [[ ${1:-} == --help ]]; then
  echo 'Usage: bash preflight.sh [--json] [--repo PATH]'
  echo 'Read-only host/tool/device inventory; no installs, boots, or adb daemon startup.'
  echo 'MCP tool access and GUI permissions require a separate in-session check.'
  exit 0
fi
command -v python3 >/dev/null || { echo 'Install Python 3 or run inventory manually.' >&2; exit 2; }
python3 - "$@" <<'PY'
import argparse, glob, json, os, pathlib, platform, shutil, socket, subprocess
p=argparse.ArgumentParser(); p.add_argument('--json',action='store_true'); p.add_argument('--repo',default=os.getcwd()); a=p.parse_args()
root=pathlib.Path(a.repo).resolve()
if not (root/'src-tauri/tauri.conf.json').is_file(): p.error('--repo must name a Thunderbolt checkout')
def run(args):
    try:
        r=subprocess.run(args,capture_output=True,text=True,timeout=12)
        return r.stdout.strip() if r.returncode==0 else None
    except (OSError,subprocess.TimeoutExpired): return None
def tool(name,args):
    path=shutil.which(name)
    return {'path':path,'version':(run([path,*args]) or 'probe failed').splitlines()[0]} if path else {'path':None,'version':None}
names={'docker':['--version'],'bun':['--version'],'node':['--version'],'cargo':['--version'],'codex':['--version'],'argent':['--version'],'claude':['--version'],'playwright-cli':['--version']}
tools={n:tool(n,args) for n,args in names.items()}
docker=bool(tools['docker']['path'] and run(['docker','info','--format','{{.ServerVersion}}']))
xcode=run(['xcode-select','-p']) if platform.system()=='Darwin' else None
simctl=run(['xcrun','--find','simctl']) if xcode else None
sims={'available':[],'booted':[],'probe_status':'unavailable/not macOS'}
if xcode:
    sims['probe_status']='failed/inaccessible'
    raw=run(['xcrun','simctl','list','devices','available','--json'])
    if raw:
        try:
            devices=[d for group in json.loads(raw).get('devices',{}).values() for d in group]
            sims={k:[{'name':d['name'],'udid':d['udid'],'state':d['state']} for d in devices if k=='available' or d['state']=='Booted'] for k in ('available','booted')}
            sims['probe_status']='ok'
        except (ValueError,KeyError): pass
sdk_default=pathlib.Path.home()/('Library/Android/sdk' if platform.system()=='Darwin' else 'Android/Sdk')
sdk=pathlib.Path(os.environ.get('ANDROID_SDK_ROOT') or os.environ.get('ANDROID_HOME') or str(sdk_default))
def android_path(name,relative):
    return shutil.which(name) or (str(sdk/relative) if (sdk/relative).is_file() else None)
adb=android_path('adb','platform-tools/adb'); emulator=android_path('emulator','emulator/emulator')
avds=(run([emulator,'-list-avds']) or '').splitlines() if emulator else []
android_devices='not queried (adb daemon absent or inaccessible)'
if adb:
    try:
        with socket.create_connection(('127.0.0.1',5037),timeout=.2): pass
        android_devices=run([adb,'devices']) or 'probe failed'
    except OSError: pass
java_candidates=[os.environ.get('JAVA_HOME',''),*glob.glob('/Library/Java/JavaVirtualMachines/*/Contents/Home'),*glob.glob('/usr/lib/jvm/*')]
java17=[]
for home in dict.fromkeys(java_candidates):
    if not home: continue
    binary=pathlib.Path(home)/'bin/java'
    if not binary.is_file(): continue
    try:
        r=subprocess.run([str(binary),'-version'],capture_output=True,text=True,timeout=5)
        if 'version "17.' in r.stderr+r.stdout: java17.append(home)
    except (OSError,subprocess.TimeoutExpired): pass
pw=root/'node_modules/.bin/playwright'
data={'os':platform.system(),'arch':platform.machine(),'repo':str(root),'tools':tools,'docker_daemon':docker,'xcode':xcode,'simctl':simctl,'simulators':sims,'android':{'sdk':str(sdk),'adb':adb,'emulator':emulator,'avds':avds,'devices':android_devices},'java17':java17,'playwright_local':str(pw) if pw.exists() else None,'capability_note':'Inventory only. Inspect live MCP tools, sandbox networking, browser launch, and GUI permissions before assigning platform availability.'}
if a.json: print(json.dumps(data,indent=2))
else:
    print(f'Host: {data["os"]} {data["arch"]}\nRepository: {root}')
    print('CHECK                 RESULT')
    for name,t in tools.items(): print(f'{name:21} {t["version"] or "missing"}')
    print(f'Docker daemon         {"reachable" if docker else "unreachable/missing"}')
    print(f'Xcode                 {xcode or "missing/not macOS"}')
    print('simctl                '+(simctl or 'missing/inaccessible'))
    print('iOS inventory probe   '+sims['probe_status'])
    for key in ('booted','available'): print(f'iOS {key:17} '+(', '.join(d['name']+' ['+d['udid']+']' for d in sims[key]) or ('none' if sims['probe_status']=='ok' else 'unknown (probe unavailable)')))
    print(f'Android SDK           {sdk}\nadb                   {adb or "missing"}\nemulator              {emulator or "missing"}')
    print('AVDs                  '+(', '.join(avds) or 'none'))
    print('Android devices       '+android_devices.replace('\n','; '))
    print('Java 17 homes         '+(', '.join(java17) or 'not found'))
    print('Playwright local      '+(data['playwright_local'] or 'missing'))
    print(data['capability_note'])
PY
