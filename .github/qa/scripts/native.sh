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
#   native.sh install <platform> <device> <app-path>
#   native.sh logs <platform> <device> <file>                   stream the WebView console to <file> in the
#                                                               background, pid in <file>.pid
#   native.sh stop-logs <file>
#
# iOS uses $QA_IOS_DEVICE (a simulator UDID) when it is set, and otherwise an iPhone 17 Pro Max on the newest iOS
# runtime. Android boots the AVD qa-android (an emulator needs KVM, so CI only) and reverses the stack's ports.

# shellcheck disable=SC2154 # backend_url, fake_google_url and frontend_env come from the eval below
set -euo pipefail
cd "$(dirname "$0")/../../.."

# The stack's own URLs and VITE_* settings, read from stack.sh so the two cannot drift.
eval "$(sed -n '/^backend_url=/p; /^fake_google_url=/p; /^frontend_env=(/,/^)/p' .github/qa/scripts/stack.sh)"

fixtures=.github/qa/fixtures
stack_ports="8005 9878 9879 9880"

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
  jq --slurpfile real src-tauri/tauri.conf.json --arg extra "$backend_url $fake_google_url" --arg cmd "$inject" \
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
  local abi=x86_64 avd=qa-android
  case $(uname -m) in arm64 | aarch64) abi=arm64-v8a ;; esac
  if ! avdmanager list avd -c | grep -qx "$avd"; then
    echo no | avdmanager create avd --name "$avd" --package "system-images;android-36;google_apis;$abi" --device pixel_7 >&2
    echo "hw.keyboard=no" >> "$ANDROID_AVD_HOME/$avd.avd/config.ini"
  fi
  if ! adb devices | grep -q '^emulator-'; then
    emulator -avd "$avd" -no-window -no-audio -no-boot-anim > /tmp/qa-emulator.log 2>&1 &
  fi
  adb wait-for-device
  local serial
  serial=$(adb devices | sed -n 's/^\(emulator-[0-9]*\).*/\1/p' | head -1)
  for _ in $(seq 180); do
    [ "$(adb -s "$serial" shell getprop sys.boot_completed | tr -d '\r')" = 1 ] && break
    sleep 2
  done
  [ "$(adb -s "$serial" shell getprop sys.boot_completed | tr -d '\r')" = 1 ] || die "the emulator did not boot"
  for port in $stack_ports; do adb -s "$serial" reverse "tcp:$port" "tcp:$port" >&2; done
  adb -s "$serial" push "$fixtures"/*.png "$fixtures"/*.pdf /sdcard/Download/ >&2
  echo "$serial"
}

logs() {
  local platform=$1 device=$2 file=$3
  if [ "$platform" = ios ]; then
    xcrun simctl spawn "$device" log stream --level debug --style compact --predicate 'eventMessage CONTAINS "CONSOLE"' --timeout 2h > "$file" 2>&1 &
  else
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

usage="usage: $0 config <platform> <out-json> [control] | build <platform> <out-dir> [onboarding] [control] | device <platform> | install <platform> <device> <app-path> | logs <platform> <device> <file> | stop-logs <file>"
[ $# -ge 1 ] || die "$usage"
command=$1
shift
if [ "$command" = stop-logs ]; then
  [ $# -eq 1 ] || die "$usage"
  kill "$(cat "$1.pid")" 2> /dev/null || true
  rm -f "$1.pid"
  exit
fi
[ $# -ge 1 ] || die "$usage"
case $1 in ios | android) ;; *) die "platform must be ios or android, got $1" ;; esac
case $command in
  config) [ $# -ge 2 ] || die "$usage"; config "$@" ;;
  build) [ $# -ge 2 ] || die "$usage"; build "$@" ;;
  device) "device_$1" ;;
  install)
    [ $# -eq 3 ] || die "$usage"
    if [ "$1" = ios ]; then xcrun simctl install "$2" "$3"; else adb -s "$2" install -r "$3"; fi
    ;;
  logs) [ $# -eq 3 ] || die "$usage"; logs "$@" ;;
  *) die "$usage" ;;
esac
