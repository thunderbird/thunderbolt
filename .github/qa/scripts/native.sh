#!/usr/bin/env bash

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# The native apps for the QA agent, locally and in CI: build one against the stack `stack.sh serve native` runs, boot
# a device, install the app and stream the WebView's console. <platform> is ios or android.
#
#   native.sh config <platform> <out-json> [control]            Tauri config for a QA build (injects
#                                                               layout-probe.js)
#   native.sh build <platform> <out-dir> [onboarding] [control] build the app into <out-dir> (onboarding is off
#                                                               unless asked; control also injects control/cover.js)
#   native.sh device <platform>                                 boot a device, print its id on stdout
#   native.sh install <platform> <device> <app-path>            on Android also open the app until a launch gets
#                                                               past the storage check, up to 4 launches of
#                                                               $QA_WARM_SECONDS (30) each, and stop it
#   native.sh logs <platform> <device> <file>                   stream the WebView console to <file> in the
#                                                               background, pid in <file>.pid
#   native.sh stop-logs <file>
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

# The stack's own URLs and VITE_* settings, read from stack.sh so the two cannot drift.
eval "$(sed -n '/^backend_url=/p; /^fake_google_url=/p; /^frontend_env=(/,/^)/p' .github/qa/scripts/stack.sh)"

fixtures=.github/qa/fixtures
# The CI PowerSync service of c7, reached by the app through POWERSYNC_URL, which the backend hands out.
powersync=localhost:18081
stack_ports="8005 9878 9879 9880 ${powersync#*:}"

die() {
  echo "$*" >&2
  exit 2
}

# Writes the dev config with the CSP that lets the app reach the stack. The Android build keeps its own identifier:
# the dev one points the Gradle project at a package directory that does not exist.
config() {
  # shellcheck disable=SC2016 # jq variables, not shell ones
  local filter='.app.security.csp["connect-src"] = $real[0].app.security.csp["connect-src"] + " " + $extra'
  [ "$1" = android ] && filter="$filter | del(.identifier)"
  # Every QA build carries the layout probe as an inline script, and the control build cover.js after it. Runs from
  # the repo root, like the `bun run build` it replaces.
  local inject='bun run build && bun -e '\''const f = "dist/index.html"; const html = await Bun.file(f).text(); if (!html.includes("</head>")) throw new Error("no </head>"); const scripts = await Promise.all(process.argv.slice(1).map((s) => Bun.file(s).text())); await Bun.write(f, html.replace("</head>", () => scripts.map((js) => "<script>" + js + "</script>").join("") + "</head>"))'\'' .github/qa/layout-probe.js'
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

# An existing qa-iphone-17-pro-max, or a new one on the newest iOS runtime.
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

device_android() {
  export ANDROID_AVD_HOME=${ANDROID_AVD_HOME:-$HOME/.android/avd}
  mkdir -p "$ANDROID_AVD_HOME"
  local abi=x86_64 avd=qa-android avds devices
  case $(uname -m) in arm64 | aarch64) abi=arm64-v8a ;; esac
  # Captured first: `grep -q` closing the pipe early fails the producer under pipefail.
  avds=$(avdmanager list avd -c)
  if ! grep -qx "$avd" <<< "$avds"; then
    echo no | avdmanager create avd --name "$avd" --package "system-images;android-36;google_apis;$abi" --device pixel_7 >&2
    local config="$ANDROID_AVD_HOME/$avd.avd/config.ini"
    grep -v '^hw.keyboard=' "$config" > "$config.tmp" || true
    mv "$config.tmp" "$config"
    echo "hw.keyboard=no" >> "$config"
  fi
  local emulator_pid=
  devices=$(adb devices)
  if ! grep -q '^emulator-' <<< "$devices"; then
    emulator -avd "$avd" -no-window -no-audio -no-snapshot -no-boot-anim -gpu swiftshader_indirect > /tmp/qa-emulator.log 2>&1 &
    emulator_pid=$!
  fi
  # Up to 10 minutes for the device to show up, and a dead emulator ends the wait at once.
  local serial=
  for _ in $(seq 300); do
    if [ -n "$emulator_pid" ] && ! kill -0 "$emulator_pid" 2> /dev/null; then
      tail -30 /tmp/qa-emulator.log >&2
      die "the emulator exited"
    fi
    serial=$(adb devices | sed -n '/^emulator-[0-9]*[[:space:]]*device$/{s/[[:space:]].*//p;q;}')
    [ -n "$serial" ] && break
    sleep 2
  done
  [ -n "$serial" ] || die "no emulator came online"
  for _ in $(seq 180); do
    [ "$(adb -s "$serial" shell getprop sys.boot_completed | tr -d '\r')" = 1 ] && break
    sleep 2
  done
  [ "$(adb -s "$serial" shell getprop sys.boot_completed | tr -d '\r')" = 1 ] || die "the emulator did not boot"
  for port in $stack_ports; do adb -s "$serial" reverse "tcp:$port" "tcp:$port" >&2; done
  # sys.boot_completed comes before the emulated storage is mounted: until then /sdcard does not resolve, and both
  # mkdir and push fail (runs 39343228365 and 39344254036).
  for _ in $(seq 90); do
    adb -s "$serial" shell test -d /sdcard/Android && break
    sleep 2
  done
  adb -s "$serial" shell test -d /sdcard/Android || die "the emulator's /sdcard never mounted"
  adb -s "$serial" shell mkdir -p /sdcard/Download
  # One at a time, and a refused push only warns: Android 16 refused sample.png with "Operation not permitted", and a
  # session without that fixture still runs.
  for file in "$fixtures"/*.png "$fixtures"/*.pdf; do
    adb -s "$serial" push "$file" /sdcard/Download/ >&2 || echo "warning: could not push $(basename "$file") to the emulator" >&2
  done
  echo "$serial"
}

logs() {
  local platform=$1 device=$2 file=$3
  if [ "$platform" = ios ]; then
    xcrun simctl spawn "$device" log stream --level debug --style compact --predicate 'eventMessage CONTAINS "CONSOLE"' --timeout 2h > "$file" 2>&1 &
  else
    # logcat first replays its whole buffer, so lines of an earlier run would look like this one's.
    adb -s "$device" logcat -c
    adb -s "$device" logcat -v epoch -s 'Tauri/Console:*' > "$file" 2>&1 &
  fi
  echo $! > "$file.pid"
  [ "$platform" = ios ] || return 0
  # Console lines written before the stream attaches are lost, so wait for its header.
  for _ in $(seq 100); do
    grep -q 'Filtering the log data' "$file" && return
    sleep 0.2
  done
  die "the log stream never attached"
}

install_app() {
  local platform=$1 device=$2 app=$3 app_id pid lines='' deadline last
  if [ "$platform" = ios ]; then
    xcrun simctl install "$device" "$app"
    return
  fi
  adb -s "$device" install -r "$app"
  # A fresh install's first opens can time out on the IndexedDB check and stop the init (runs 39373388149 and
  # 39380764343, several in a row), so the app is opened until a launch gets past it.
  app_id=$(jq -r '.[] | select(.id == "android") | .appId' .github/qa/platforms.json)
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
  rm -f "$1.pid"
}

# The positive control: runs control/native-control.yaml on the calibration build already installed on the
# device, with the WebView log on, and exits 0 only when the keyboard is open and the probe logged focus-covered for the
# Email field. The flow, log and hierarchy stay in <out-dir>.
control() {
  local platform=$1 device=$2 out=${3:-$(mktemp -d)} app_id
  mkdir -p "$out"
  app_id=$(jq -r --arg p "$platform" '.[] | select(.id == $p) | .appId' .github/qa/platforms.json)
  { printf 'appId: %s\n---\n' "$app_id"; cat .github/qa/control/native-control.yaml; } > "$out/flow.yaml"
  export MAESTRO_CLI_NO_ANALYTICS=1 MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true MAESTRO_DRIVER_STARTUP_TIMEOUT=180000
  # shellcheck disable=SC2064 # $out is fixed by now
  trap "stop_logs '$out/webview.log'" EXIT
  logs "$platform" "$device" "$out/webview.log"
  # The iOS driver sometimes is not ready in time, so one more try.
  maestro --udid "$device" test "$out/flow.yaml" > "$out/maestro.log" 2>&1 \
    || maestro --udid "$device" test "$out/flow.yaml" > "$out/maestro.log" 2>&1 \
    || { tail -20 "$out/maestro.log" >&2; die "the control flow failed"; }
  # The probe debounces 250 ms and confirms a problem over 500 ms; a plain build never logs the line, so it waits it out.
  for _ in $(seq 20); do
    grep -q 'focus-covered' "$out/webview.log" && break
    sleep 0.5
  done
  maestro --udid "$device" hierarchy > "$out/hierarchy.json" 2> "$out/hierarchy.err"
  # shellcheck disable=SC2016 # JS, not shell
  bun -e 'import { controlVerdict } from "./.github/qa/native-layout.ts"; const [platform, hierarchy, log] = process.argv.slice(1); const { ok, lines } = controlVerdict({ platform, hierarchy: await Bun.file(hierarchy).text(), log: await Bun.file(log).text() }); console.log(lines.join("\n")); process.exit(ok ? 0 : 1)' \
    "$platform" "$out/hierarchy.json" "$out/webview.log"
}

# The build half of a fix's native verification: applies <patch> (`qa-out/fix/<fp>.patch`) in a temporary
# worktree and builds the app there into <out-dir>, with onboarding for a c1 session. The patched tree's code runs
# here (the build, and through it anything the patch adds), so this only outputs the app: the verdict comes from
# verify-run in a checkout this never ran in, in CI a later job on a fresh checkout.
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
# with the videos beside it. A finding's repro flow sits in the run's qa-out, whose verified.json holds its oracle; any
# other flow is the fix agent's visual check. <original-app> is the build-native artifact of the same variant, without
# the patch, where the flow must fail too: a visual check and a real-AI session need it.
verify_run() {
  local platform=$1 device=$2 app=$3 flow=$4 session=$5 result=$6 original=${7:-} work name
  : "${QA_BACKEND_LOG:?must name the log of the stack, for the http-5xx oracle}"
  work=$(mktemp -d)
  # shellcheck disable=SC2064 # the path is fixed by now
  trap "stop_logs '$work/webview.log'; rm -rf '$work'" EXIT
  logs "$platform" "$device" "$work/webview.log"
  mkdir -p "$(dirname "$result")"
  name=$(basename "$result")
  QA_WEBVIEW_LOG="$work/webview.log" bun .github/qa/scripts/verify.ts fix-native --out "$(dirname "$result")" \
    --native "$platform" --device "$device" --app "$app" --fp "${name%%.*}" --flow "$flow" \
    --session "$session" --result "$result" ${original:+--original "$original"}
}

usage="usage: $0 config <platform> <out-json> [control] | build <platform> <out-dir> [onboarding] [control] | device <platform> | install <platform> <device> <app-path> | logs <platform> <device> <file> | stop-logs <file> | control <platform> <device> [out-dir] | verify-build <platform> <patch> <session> <out-dir> | verify-run <platform> <device> <app> <flow> <session> <out-json> [original-app]"
[ $# -ge 1 ] || die "$usage"
command=$1
shift
if [ "$command" = stop-logs ]; then
  [ $# -eq 1 ] || die "$usage"
  stop_logs "$1"
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
