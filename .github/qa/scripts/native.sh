#!/usr/bin/env bash

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# The native apps for the QA agent, locally and in CI: build one against the stack `stack.sh serve native` runs, boot
# a device, install the app and stream the WebView's console. <platform> is ios or android.
#
#   native.sh config <platform> <out-json> [control]            Tauri config for a QA build (injects axe-core
#                                                               and layout-probe.js)
#   native.sh build <platform> <out-dir> [onboarding] [control] build the app into <out-dir> (onboarding is off
#                                                               unless asked; control also injects control/cover.js)
#   native.sh system-image                                      Android only: install the emulator and the AVD's
#                                                               system image, retrying once after a failed download
#   native.sh device <platform>                                 boot a device, print its id on stdout
#   native.sh device-lost <device> <seconds>                    Android only: print what may explain why adb lost
#                                                               the emulator, for the job log; adb's own answer
#                                                               gets <seconds>
#   native.sh install <platform> <device> <app-path>            on Android also reverse the stack's ports again and
#                                                               open the app until a launch gets past the storage
#                                                               check, up to 4 launches of $QA_WARM_SECONDS (30)
#                                                               each, and stop it
#   native.sh logs <platform> <device> <file>                   stream the WebView console to <file> in the
#                                                               background, pid in <file>.pid; on iOS it returns at
#                                                               once and records the start time in <file>.start
#   native.sh wait-logs <device> <file>                         iOS only: wait for that stream to attach, replacing
#                                                               it once; the first gets until 60 s after its start,
#                                                               the replacement 60 s of its own
#   native.sh stop-logs <file>
#   native.sh resume-logs <device> <file>                       Android only: after adb lost the device, stream
#                                                               again into <file>, appending from the newest line;
#                                                               fails when the new stream exits within a second
#   native.sh control <platform> <device> [out-dir]             run the positive control on the control build
#                                                               installed on <device>; exit 0 when the layout check
#                                                               reports the covered Email field
#   native.sh verify-build <platform> <patch> <session> <out-dir>
#                                                               build the app with a fix's patch (see verify_build)
#   native.sh verify-run <platform> <device> <app> <flow> <session> <out-json> [original-app]
#                                                               run a fix's flow three times on that app and write
#                                                               the verdict (see verify_run)
#
# iOS uses $QA_IOS_DEVICE (a simulator UDID) when it is set, and otherwise an iPhone 17 Pro Max on the newest iOS
# runtime. Android boots the AVD qa-android (an emulator needs KVM, so CI only) and reverses the stack's ports.

# shellcheck disable=SC2154 # backend_url, fake_google_url and frontend_env come from the eval below
set -euo pipefail
cd "$(dirname "$0")/../../.."

# Read from stack.sh so the URLs and VITE_* settings cannot drift from the stack's.
. .github/qa/scripts/ports.sh
eval "$(sed -n '/^backend_url=/p; /^fake_google_url=/p; /^frontend_env=(/,/^)/p' .github/qa/scripts/stack.sh)"

fixtures=.github/qa/fixtures
# c7's CI PowerSync service, which the backend hands to the app through POWERSYNC_URL.
powersync=localhost:18081
stack_ports="$QA_BACKEND_PORT $QA_PROVIDER_PORT $QA_MCP_PORT $QA_GOOGLE_PORT ${powersync#*:}"
android_abi=x86_64
case $(uname -m) in arm64 | aarch64) android_abi=arm64-v8a ;; esac
android_image="system-images;android-36;google_apis;$android_abi"
avd=qa-android
# The emulator's pid and the kernel's OOM kill count at its boot. Each boot n also keeps its own log and exit status
# (qa-emulator-<n>.log and qa-emulator-<n>.status).
emulator_files=${TMPDIR:-/tmp}/qa-emulator
crash_signatures=(fatal error crash abort assert segfault segmentation sigsegv sigabrt 'terminating on signal' killed
  'out of memory' kvm)
# Lines that match a signature without being a crash line: the crash reporter's set-up, which every boot logs, and
# bash's report of the signal that ended the emulator, which the boot's .status file already records.
routine_lines='Storing crashdata in|: line [0-9]+: +[0-9]+ .*"\$@"$'

die() {
  echo "$*" >&2
  exit 2
}

# adb drops the mappings when its connection to the device resets. adb prints each mapped port, which would land in
# the job log as bare numbers right under device-lost's report.
reverse_ports() {
  for port in $stack_ports; do adb -s "$1" reverse "tcp:$port" "tcp:$port" > /dev/null; done
}

# The Android build keeps its own identifier: the dev one points the Gradle project at a package directory that does
# not exist.
config() {
  # shellcheck disable=SC2016 # jq variables, not shell ones
  local filter='.app.security.csp["connect-src"] = $real[0].app.security.csp["connect-src"] + " " + $extra'
  [ "$1" = android ] && filter="$filter | del(.identifier)"
  # Runs from the repo root, like the `bun run build` it replaces.
  local inject='bun run build && bun -e '\''const f = "dist/index.html"; const html = await Bun.file(f).text(); if (!html.includes("</head>")) throw new Error("no </head>"); const scripts = await Promise.all(process.argv.slice(1).map((s) => Bun.file(s).text())); await Bun.write(f, html.replace("</head>", () => scripts.map((js) => "<script>" + js + "</script>").join("") + "</head>"))'\'' node_modules/axe-core/axe.min.js .github/qa/layout-probe.js'
  [ "${3:-}" = control ] && inject="$inject .github/qa/control/cover.js"
  filter="$filter | .build.beforeBuildCommand = \$cmd"
  jq --slurpfile real src-tauri/tauri.conf.json --arg extra "$backend_url $fake_google_url http://$powersync ws://$powersync" --arg cmd "$inject" \
    "$filter" src-tauri/tauri.dev.conf.json > "$2"
}

# The tracked files a Tauri mobile build rewrites, and the one it adds.
restore_gen() {
  git checkout -- src-tauri/gen
  rm -f src-tauri/plugins/tauri-plugin-passkey/ios/Package.resolved
}

# Runs <command> with its output also in <log>. A cold SwiftPM fetch that loses the network shows up as git failing
# on the swift-rs cache it never cloned, so that failure gets one more build after a short wait.
retry_swiftpm_fetch() {
  local log=$1 status=0
  shift
  "$@" 2>&1 | tee "$log" || status=$?
  [ "$status" -ne 0 ] || return 0
  grep -q 'repositories/swift-rs-[^ ]* config --get remote.origin.url.*No such file or directory' "$log" || return "$status"
  echo "warning: the build lost the network while SwiftPM fetched swift-rs; building once more" >&2
  sleep 10
  "$@"
}

build() {
  local platform=$1 out=$2 skip_onboarding=true control=
  shift 2
  for flag in "$@"; do
    case $flag in
      onboarding) skip_onboarding=false ;;
      control) control=control ;;
      *) die "unknown build flag: $flag" ;;
    esac
  done
  mkdir -p "$out"
  config "$platform" "$out/tauri.conf.json" "$control"
  trap restore_gen EXIT
  # The build writes cover.js into dist/index.html; the next build rewrites dist, but nobody else should pick it up.
  [ -z "$control" ] || trap 'restore_gen; rm -rf dist' EXIT
  local run=(env "${frontend_env[@]}" "VITE_SKIP_ONBOARDING=$skip_onboarding")
  if [ "$platform" = ios ]; then
    # Tauri fails to rename over an existing .app.
    rm -rf src-tauri/gen/apple/build/arm64-sim
    retry_swiftpm_fetch "$out/build.log" \
      "${run[@]}" bun tauri ios build --target aarch64-sim --debug --ci --no-sign --config "$out/tauri.conf.json"
    rm -rf "$out/Thunderbolt Dev.app"
    cp -R "src-tauri/gen/apple/build/arm64-sim/Thunderbolt Dev.app" "$out/"
    return
  fi
  local arch=x86_64
  case $(uname -m) in arm64 | aarch64) arch=aarch64 ;; esac
  rm -rf src-tauri/gen/android/app/build/outputs/apk
  "${run[@]}" bun tauri android build --debug --apk --target "$arch" --ci --config "$out/tauri.conf.json"
  find src-tauri/gen/android/app/build/outputs/apk -name '*-debug.apk' -exec cp {} "$out/app-debug.apk" \;
  [ -f "$out/app-debug.apk" ] || die "no debug APK was built"
}

ios_create() {
  local name=qa-iphone-17-pro-max found runtime
  found=$(xcrun simctl list devices available -j | jq -r --arg n "$name" '[.devices[][] | select(.name == $n)][0].udid // empty')
  if [ -n "$found" ]; then
    echo "$found"
    return
  fi
  runtime=$(xcrun simctl list runtimes available -j | jq -r '[.runtimes[] | select(.platform == "iOS")] | max_by(.version | split(".") | map(tonumber)) | .identifier')
  xcrun simctl create "$name" com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max "$runtime"
}

device_ios() {
  local udid=${QA_IOS_DEVICE:-$(ios_create)}
  # The Simulator window reads this at launch. A hardware keyboard stops the on-screen one from opening.
  defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false
  # -b boots the device when it is not booted yet, and waits until it is ready.
  xcrun simctl bootstatus "$udid" -b >&2
  # Without this the WebView's console never reaches the system log.
  xcrun simctl spawn "$udid" defaults write -g WebKitDebugLogsPageMessagesToSystemConsoleEnabled -bool true
  # Images only: addmedia aborts on any other file, such as the .txt ones.
  xcrun simctl addmedia "$udid" "$fixtures"/*.png
  echo "$udid"
}

# A download can arrive corrupt ("Error on ZipFile unknown archive"), so the retry starts without what it left behind.
system_image() {
  local sdk=${ANDROID_HOME:?}
  local sdkmanager=$sdk/cmdline-tools/latest/bin/sdkmanager
  yes | "$sdkmanager" --licenses > /dev/null || true
  "$sdkmanager" --install emulator "$android_image" > /dev/null && return
  echo "warning: sdkmanager failed; removing its partial downloads and trying once more" >&2
  rm -rf "${sdk:?}/.downloadIntermediates" "${sdk:?}/.temp" "${sdk:?}/${android_image//;//}"
  "$sdkmanager" --install emulator "$android_image" > /dev/null
}

# A system error dialog ("System UI isn't responding") covers the app and hides its screen from Maestro. The setting
# stops system_server from showing any new ANR or crash dialog; the broadcast closes one already on screen, which
# the setting alone leaves in place (the dialogs listen for it, and the shell may send it), so a refusal only warns.
# An app that stops responding is killed instead of asked to wait, so a hang shows as the app disappearing.
hide_error_dialogs() {
  local serial=$1
  adb -s "$serial" shell settings put global hide_error_dialogs 1
  adb -s "$serial" shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS > /dev/null ||
    echo "warning: could not close a system dialog already on screen" >&2
  [ "$(adb -s "$serial" shell settings get global hide_error_dialogs | tr -d '\r')" = 1 ] ||
    die "the emulator ignored hide_error_dialogs, so a system error dialog can cover the app during a flow"
}

# Empty without /proc (macOS).
oom_kills() {
  awk '$1 == "oom_kill" { print $2 }' /proc/vmstat 2> /dev/null || true
}

# Our emulator from an earlier boot, which adb lost. Only while its pid still runs our AVD: a pid can be reused.
stop_emulator() {
  local pid
  pid=$(cat "$emulator_files.pid" 2> /dev/null) || return 0
  [[ $(ps -ww -o args= -p "$pid" 2> /dev/null) == *" -avd $avd "* ]] || return 0
  kill "$pid" 2> /dev/null || return 0
  for _ in $(seq 20); do
    kill -0 "$pid" 2> /dev/null || return 0
    sleep 0.5
  done
  kill -9 "$pid" 2> /dev/null || true
}

# For each crash signature, the numbers of the latest boot's emulator log lines that hold it, routine lines left out.
# Line numbers only: this reaches the job log on every leg, the real one too.
crash_lines() {
  local boot log signature lines found=''
  boot=$(last_boot)
  log=$emulator_files-$boot.log
  echo "crash lines in the emulator's log of boot $boot ($(basename "$log")), by signature:"
  for signature in "${crash_signatures[@]}"; do
    lines=$(grep -niF -- "$signature" "$log" 2> /dev/null | grep -vE -- "$routine_lines" |
      sed 's/:.*//; s/^/line /' | paste -sd, -) || continue
    found=1
    echo "  $signature: ${lines//,/, }"
  done
  [ -n "$found" ] || echo "  none"
}

# Pkg.Revision from the source.properties in <dir>, the SDK package's version, or "unknown".
pkg_revision() {
  sed -n 's/^Pkg\.Revision=//p' "$1/source.properties" 2> /dev/null | grep . || echo unknown
}

# The number of our emulator's latest boot in this job, 0 before the first.
last_boot() {
  local n=0
  while [ -e "$emulator_files-$((n + 1)).log" ]; do n=$((n + 1)); done
  echo "$n"
}

# Runs the emulator, records its pid, and once it ends writes how it ended to <status>, atomically. The caller starts
# this in the background, so it outlives native.sh and device-lost can read how the emulator ended.
watch_emulator() {
  local status=$1 code=0 name
  shift
  "$@" &
  echo $! > "$emulator_files.pid"
  wait $! || code=$?
  # bash reports a death by signal N as 128 + N, which `kill -l` names. An exit code that also names a signal, such as
  # 139, reads the same way; one that names none, such as 255, stays an exit code.
  if [ "$code" -gt 128 ] && name=$(kill -l "$code" 2> /dev/null); then
    echo "was killed by signal $((code - 128)) (SIG$name)"
  else
    echo "exited with code $code"
  fi > "$status.tmp"
  mv "$status.tmp" "$status"
}

online_emulators() {
  adb devices | sed -n 's/^\(emulator-[0-9]*\)[[:space:]]*device$/\1/p'
}

# The online emulator that runs our AVD, if any. Another emulator on the same adb is not ours to use.
our_emulator() {
  local serial name
  for serial in $(online_emulators); do
    name=$(timeout -k 1 10 adb -s "$serial" shell getprop ro.boot.qemu.avd_name 2> /dev/null | tr -d '\r') || true
    if grep -qx "$avd" <<< "$name"; then
      echo "$serial"
      return
    fi
  done
}

# The first even console port from 5554 to 5584 where adb lists no emulator. An offline row counts: the emulator adb
# lost may still hold its port.
free_port() {
  local devices port
  devices=$(adb devices)
  for port in $(seq 5554 2 5584); do
    if ! grep -q "^emulator-${port}[[:space:]]" <<< "$devices"; then
      echo "$port"
      return
    fi
  done
  die "adb lists an emulator on every console port from 5554 to 5584"
}

device_android() {
  export ANDROID_AVD_HOME=${ANDROID_AVD_HOME:-$HOME/.android/avd}
  mkdir -p "$ANDROID_AVD_HOME"
  local avds
  # Captured first: `grep -q` closing the pipe early fails the producer under pipefail.
  avds=$(avdmanager list avd -c)
  if ! grep -qx "$avd" <<< "$avds"; then
    echo no | avdmanager create avd --name "$avd" --package "$android_image" --device pixel_7 >&2
    local config="$ANDROID_AVD_HOME/$avd.avd/config.ini"
    grep -v '^hw.keyboard=' "$config" > "$config.tmp" || true
    mv "$config.tmp" "$config"
    echo "hw.keyboard=no" >> "$config"
  fi
  local status='' serial port boot
  serial=$(our_emulator)
  # Our AVD must be online: an offline row is an emulator adb lost, and waiting for it to come back would take the
  # whole 10-minute wait below.
  if [ -z "$serial" ]; then
    stop_emulator
    # adb names an emulator after its console port, so the boot waits for that serial and takes no other emulator.
    port=$(free_port)
    serial=emulator-$port
    boot=$(($(last_boot) + 1))
    status=$emulator_files-$boot.status
    # Neither is pinned, so an SDK update or a refreshed system image cache shows here.
    echo "boot $boot: emulator $(pkg_revision "$(dirname "$(command -v emulator)")"), $android_image revision" \
      "$(pkg_revision "${ANDROID_HOME:-}/${android_image//;//}")" >&2
    # The watcher's output goes to the log too, so it never holds the caller's stdout or stderr open.
    watch_emulator "$status" emulator -avd "$avd" -port "$port" -no-window -no-audio -no-snapshot -no-boot-anim \
      -gpu swiftshader_indirect > "$emulator_files-$boot.log" 2>&1 &
    oom_kills > "$emulator_files.oom"
  fi
  # A dead emulator ends the wait at once.
  for _ in $(seq 300); do
    if [ -n "$status" ] && [ -f "$status" ]; then
      crash_lines >&2
      die "the emulator $(cat "$status")"
    fi
    grep -qxF "$serial" <<< "$(online_emulators)" && break
    sleep 2
  done
  grep -qxF "$serial" <<< "$(online_emulators)" || die "no emulator came online"
  for _ in $(seq 180); do
    [ "$(adb -s "$serial" shell getprop sys.boot_completed | tr -d '\r')" = 1 ] && break
    sleep 2
  done
  [ "$(adb -s "$serial" shell getprop sys.boot_completed | tr -d '\r')" = 1 ] || die "the emulator did not boot"
  hide_error_dialogs "$serial"
  reverse_ports "$serial"
  # Room for a whole replay leg, so the log a job saves at its end still holds its first runs: about 5 MB an hour.
  adb -s "$serial" logcat -b main,system,crash,events -G 64M >&2 || echo "warning: could not grow the emulator's log" >&2
  # sys.boot_completed comes before the emulated storage is mounted: until then /sdcard does not resolve, and both
  # mkdir and push fail.
  for _ in $(seq 90); do
    adb -s "$serial" shell test -d /sdcard/Android && break
    sleep 2
  done
  adb -s "$serial" shell test -d /sdcard/Android || die "the emulator's /sdcard never mounted"
  adb -s "$serial" shell mkdir -p /sdcard/Download
  # A refused push only warns (Android 16 refused sample.png): a session without that fixture still runs.
  for file in "$fixtures"/*.png "$fixtures"/*.pdf; do
    adb -s "$serial" push "$file" /sdcard/Download/ >&2 || echo "warning: could not push $(basename "$file") to the emulator" >&2
  done
  echo "$serial"
}

# Safe on every leg, the real one too: nothing here holds a key or what the app showed, and only line numbers leave
# the emulator's log. How the emulator ended comes from its .status file. adb gets its own hard kill: a nested `timeout` runs in a process group of its own, which the
# caller's kill never reaches.
device_lost() {
  local serial=$1 seconds=$2 pid boot now status
  pid=$(cat "$emulator_files.pid" 2> /dev/null) || pid=
  boot=$(cat "$emulator_files.oom" 2> /dev/null) || boot=
  now=$(oom_kills)
  status=$emulator_files-$(last_boot).status
  {
    echo "adb lost $serial; adb's state for it now: $(timeout -k 1 "$seconds" adb -s "$serial" get-state 2>&1 || true)"
    if [ -f "$status" ]; then
      echo "the emulator (pid ${pid:-unknown}) $(cat "$status")"
    elif [ -n "$pid" ] && kill -0 "$pid" 2> /dev/null; then
      echo "the emulator (pid $pid) still runs"
    else
      echo "the emulator (pid ${pid:-unknown}) is gone, with no exit status recorded"
    fi
    free -m 2> /dev/null || true
    if [ -n "$boot" ] && [ -n "$now" ]; then echo "OOM kills since the emulator booted: $((now - boot))"; fi
    crash_lines
  } >&2
}

# Starts the iOS stream into a fresh <file> and records its pid. It starts right after the
# boot, so its 7 h limit has to outlast replay-native's 360-minute job.
start_ios_stream() {
  # A killed stream's process can outlive its wrapper; unlinking keeps it from overwriting the new stream's file.
  rm -f "$2"
  # Polling can run before the background child opens its redirect; create the file synchronously.
  : > "$2"
  xcrun simctl spawn "$1" log stream --level debug --style compact --predicate 'eventMessage CONTAINS "CONSOLE"' --timeout 7h > "$2" 2>&1 &
  echo $! > "$2.pid"
}

# Waits up to <seconds> for the stream's header; with none left it checks once.
wait_for_header() {
  local i
  for ((i = 0; i < $2 * 5; i++)); do
    grep -q 'Filtering the log data' "$1" && return
    sleep 0.2
  done
  grep -q 'Filtering the log data' "$1"
}

# Console lines written before the stream attaches are lost. On a slow runner it can take over a minute to attach,
# or never, so a stream still silent 60 s after `logs ios` started it is replaced once. The first wait counts from that
# start, so time spent on other steps since then is not waited again; the replacement gets 60 s of its own, because
# those steps can already have used up the first stream's budget.
wait_logs() {
  local device=$1 file=$2 start
  start=$(cat "$file.start")
  wait_for_header "$file" $((start + 60 - $(date +%s))) && return
  stop_logs "$file"
  start_ios_stream "$device" "$file"
  wait_for_header "$file" 60 && return
  stop_logs "$file"
  die "the log stream never attached"
}

# On iOS this only starts the stream, so the app install and the stack start can run while it attaches; wait-logs
# then waits for it.
logs() {
  local platform=$1 device=$2 file=$3
  if [ "$platform" = ios ]; then
    start_ios_stream "$device" "$file"
    date +%s > "$file.start"
    return
  fi
  # logcat first replays its whole buffer, so lines of an earlier run would look like this one's.
  adb -s "$device" logcat -c
  adb -s "$device" logcat -v epoch -s 'Tauri/Console:*' > "$file" 2>&1 &
  echo $! > "$file.pid"
}

install_app() {
  local platform=$1 device=$2 app=$3 app_id pid lines='' deadline last
  app_id=$(jq -r --arg platform "$platform" '.[] | select(.id == $platform) | .appId' .github/qa/platforms.json)
  # A session starts on a fresh install, as every replay run does, so the explorer sees the first-run screens too.
  if [ "$platform" = ios ]; then
    xcrun simctl uninstall "$device" "$app_id" || true
    xcrun simctl install "$device" "$app"
    return
  fi
  adb -s "$device" uninstall "$app_id" > /dev/null || true
  adb -s "$device" install -r "$app"
  # Without the mappings the backend gets no request and the WebView log stream can end.
  reverse_ports "$device"
  # A fresh install's first opens can time out on the IndexedDB check and stop the init (sometimes
  # several in a row), so the app is opened until a launch gets past it.
  for _ in 1 2 3 4; do
    adb -s "$device" shell monkey -p "$app_id" -c android.intent.category.LAUNCHER 1 > /dev/null
    deadline=$((SECONDS + ${QA_WARM_SECONDS:-30}))
    while [ "$SECONDS" -lt "$deadline" ]; do
      pid=$(adb -s "$device" shell pidof "$app_id" | tr -d '\r') || true
      # Captured first: `grep -q` closing the pipe early fails the producer under pipefail.
      lines=$([ -z "$pid" ] || adb -s "$device" logcat -d --pid="$pid" -s 'Tauri/Console:*') || true
      if grep -q '\[init\] step1_' <<< "$lines"; then
        adb -s "$device" shell am force-stop "$app_id"
        return
      fi
      sleep 0.5
    done
    adb -s "$device" shell am force-stop "$app_id"
  done
  last=$(grep -o '\[init\] step0_5_storage_check.*' <<< "$lines" | tail -1) || true
  die "the app never got past the storage check in 4 launches; last: ${last:-no storage check logged}"
}

stop_logs() {
  kill "$(cat "$1.pid" 2> /dev/null)" 2> /dev/null || true
  rm -f "$1.pid" "$1.start"
}

# Unlike `logs`, it neither clears the device's log nor empties <file>, so what came before the loss stays in both.
# The old stream is stopped only while its pid still writes <file>: adb's reset may have ended it long ago, and a pid
# can be reused. Without /proc (macOS) it is left running. The command fails when the new stream has exited a second
# later.
resume_logs() {
  local device=$1 file=$2 pid stream
  pid=$(cat "$file.pid" 2> /dev/null) || pid=
  if [ -n "$pid" ] && [ "/proc/$pid/fd/1" -ef "$file" ]; then kill "$pid" 2> /dev/null || true; fi
  # -T 1 starts at the newest buffered entry, so earlier runs' lines are not streamed again. That one entry can show
  # up twice in <file> when it matches the tag filter.
  adb -s "$device" logcat -v epoch -T 1 -s 'Tauri/Console:*' >> "$file" 2>&1 &
  stream=$!
  echo "$stream" > "$file.pid"
  sleep 1
  kill -0 "$stream" 2> /dev/null || die "the new WebView log stream exited at once"
}

# Exits 0 only when the keyboard is open and the probe logged focus-covered for the Email field. The flow, log and
# hierarchy stay in <out-dir>.
control() {
  local platform=$1 device=$2 out=${3:-$(mktemp -d)} app_id
  mkdir -p "$out"
  app_id=$(jq -r --arg p "$platform" '.[] | select(.id == $p) | .appId' .github/qa/platforms.json)
  { printf 'appId: %s\n---\n' "$app_id"; cat .github/qa/control/native-control.yaml; } > "$out/flow.yaml"
  export MAESTRO_CLI_NO_ANALYTICS=1 MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true MAESTRO_DRIVER_STARTUP_TIMEOUT=180000
  # shellcheck disable=SC2064 # $out is fixed by now
  trap "stop_logs '$out/webview.log'" EXIT
  logs "$platform" "$device" "$out/webview.log"
  [ "$platform" != ios ] || wait_logs "$device" "$out/webview.log"
  # The iOS driver sometimes is not ready in time, so one more try.
  maestro --udid "$device" test "$out/flow.yaml" > "$out/maestro.log" 2>&1 \
    || maestro --udid "$device" test "$out/flow.yaml" > "$out/maestro.log" 2>&1 \
    || { tail -20 "$out/maestro.log" >&2; die "the control flow failed"; }
  # The probe debounces and confirms a problem over time; a plain build never logs the line, so wait it out.
  for _ in $(seq 20); do
    grep -q 'focus-covered' "$out/webview.log" && break
    sleep 0.5
  done
  maestro --udid "$device" hierarchy > "$out/hierarchy.json" 2> "$out/hierarchy.err"
  # shellcheck disable=SC2016 # JS, not shell
  bun -e 'import { controlVerdict } from "./.github/qa/native-layout.ts"; const [platform, hierarchy, log] = process.argv.slice(1); const { ok, lines } = controlVerdict({ platform, hierarchy: await Bun.file(hierarchy).text(), log: await Bun.file(log).text() }); console.log(lines.join("\n")); process.exit(ok ? 0 : 1)' \
    "$platform" "$out/hierarchy.json" "$out/webview.log"
}

# Applies <patch> (`qa-out/fix/<fp>.patch`) in a temporary worktree and builds the app there into <out-dir>, with
# onboarding for a c1 session. The patch's code runs here, so this only outputs the app: the verdict comes from
# verify-run on a checkout this never ran in (in CI, a fresh one in a later job).
verify_build() {
  local platform=$1 patch=$2 session=$3 out=$4 work tree onboarding=''
  mkdir -p "$out"
  # The worktree's native.sh runs from the worktree root, so a relative <out-dir> would land inside it.
  out=$(cd "$out" && pwd)
  work=$(mktemp -d)
  tree="$work/tree"
  git worktree add --quiet --detach "$tree" HEAD
  # shellcheck disable=SC2064 # the paths are fixed by now
  trap "git worktree remove --force '$tree'; rm -rf '$work'" EXIT
  git -C "$tree" apply < "$patch"
  # The checkout's dependencies and compiled crates, for speed: the patch may change neither (publish refuses
  # manifests), and this checkout never writes a verdict.
  ln -s "$PWD/node_modules" "$tree/node_modules"
  case $session in c1-first-run-*) onboarding=onboarding ;; esac
  CARGO_TARGET_DIR="$PWD/src-tauri/target" "$tree/.github/qa/scripts/native.sh" build "$platform" "$out" ${onboarding:+"$onboarding"}
}

# The run half, with no key and from this checkout's own verify.ts: runs <flow> three times on <app> (verify-build's
# output) on <device>, with the stack already serving, and writes the verdict to <out-json>, named `<fp>.<…>.json`,
# with the videos and the WebView log beside it. It exits 0 when the patch passes, 3 when the check could not tell
# whether it works, 4 when it fails, and 2 on its own errors; CI uploads the pass, the inconclusive marker or the
# failure marker on that. A finding's repro flow sits in the run's qa-out, whose verified.json holds its oracle; any
# other flow is the fix agent's visual check. <original-app> is the build-native artifact of the same variant, without
# the patch, where the flow must fail too: a visual check and a real-AI session need it.
verify_run() {
  local platform=$1 device=$2 app=$3 flow=$4 session=$5 result=$6 original=${7:-} log name
  : "${QA_BACKEND_LOG:?must name the log of the stack, for the http-5xx oracle}"
  mkdir -p "$(dirname "$result")"
  log="${result%.json}.webview.log"
  # shellcheck disable=SC2064 # the path is fixed by now
  trap "stop_logs '$log'" EXIT
  logs "$platform" "$device" "$log"
  # A stream that never attached fails before the patched app runs, which says nothing about the patch: verify.ts's
  # inconclusive code. A subshell, since `die` exits the shell it runs in.
  [ "$platform" != ios ] || (wait_logs "$device" "$log") || exit 3
  name=$(basename "$result")
  QA_WEBVIEW_LOG="$log" bun .github/qa/scripts/verify.ts fix-native --out "$(dirname "$result")" \
    --native "$platform" --device "$device" --app "$app" --fp "${name%%.*}" --flow "$flow" \
    --session "$session" --result "$result" ${original:+--original "$original"}
}

usage="usage: $0 config <platform> <out-json> [control] | build <platform> <out-dir> [onboarding] [control] | system-image | device <platform> | device-lost <device> <seconds> | install <platform> <device> <app-path> | logs <platform> <device> <file> | wait-logs <device> <file> | stop-logs <file> | resume-logs <device> <file> | control <platform> <device> [out-dir] | verify-build <platform> <patch> <session> <out-dir> | verify-run <platform> <device> <app> <flow> <session> <out-json> [original-app]"
[ $# -ge 1 ] || die "$usage"
command=$1
shift
if [ "$command" = stop-logs ]; then
  [ $# -eq 1 ] || die "$usage"
  stop_logs "$1"
  exit
fi
if [ "$command" = system-image ]; then
  [ $# -eq 0 ] || die "$usage"
  system_image
  exit
fi
if [ "$command" = wait-logs ]; then
  [ $# -eq 2 ] || die "$usage"
  wait_logs "$@"
  exit
fi
if [ "$command" = device-lost ]; then
  [ $# -eq 2 ] || die "$usage"
  device_lost "$@"
  exit
fi
if [ "$command" = resume-logs ]; then
  [ $# -eq 2 ] || die "$usage"
  resume_logs "$@"
  exit
fi
[ $# -ge 1 ] || die "$usage"
case $1 in ios | android) ;; *) die "platform must be ios or android, got $1" ;; esac
case $command in
  config) [ $# -ge 2 ] || die "$usage"; config "$@" ;;
  build) [ $# -ge 2 ] || die "$usage"; build "$@" ;;
  device) "device_$1" ;;
  install) [ $# -eq 3 ] || die "$usage"; install_app "$@" ;;
  logs) [ $# -eq 3 ] || die "$usage"; logs "$@" ;;
  control) [ $# -ge 2 ] && [ $# -le 3 ] || die "$usage"; control "$@" ;;
  verify-build) [ $# -eq 4 ] || die "$usage"; verify_build "$@" ;;
  verify-run) [ $# -ge 6 ] && [ $# -le 7 ] || die "$usage"; verify_run "$@" ;;
  *) die "$usage" ;;
esac
