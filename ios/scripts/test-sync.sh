#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this file,
# You can obtain one at https://mozilla.org/MPL/2.0/.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_PORT="${BACKEND_PORT:-18083}"
POWERSYNC_PORT="${POWERSYNC_PORT:-18082}"
POSTGRES_PORT="${POSTGRES_PORT:-15434}"
SYNC_PROVIDER_PORT="${SYNC_PROVIDER_PORT:-18789}"
BACKEND_URL="http://localhost:${BACKEND_PORT}/v1"
POWERSYNC_URL="http://localhost:${POWERSYNC_PORT}"
REUSE_SYNC_STACK="${THUNDERBOLT_REUSE_SYNC_STACK:-0}"
if [[ "$REUSE_SYNC_STACK" == 1 ]]; then
  : "${SYNC_COMPOSE_PROJECT:?Set SYNC_COMPOSE_PROJECT to the existing isolated Compose project name.}"
else
  if [[ -n "${SYNC_COMPOSE_PROJECT:-}" ]]; then
    printf 'SYNC_COMPOSE_PROJECT is only accepted with THUNDERBOLT_REUSE_SYNC_STACK=1.\n' >&2
    exit 1
  fi
  SYNC_COMPOSE_PROJECT="thunderbolt-ios-sync-test-$$-${RANDOM}"
fi
DESTINATION="${SIMULATOR_DESTINATION:-platform=iOS Simulator,name=iPhone 17 Pro}"
PACKAGE_CACHE="${SWIFTPM_PACKAGE_CACHE:-${TMPDIR:-/tmp}/thunderbolt-ios-packages}"
SUPPLIED_XCTESTRUN="${THUNDERBOLT_SYNC_XCTESTRUN:-}"
if [[ -n "${THUNDERBOLT_SYNC_DERIVED_DATA:-}" ]]; then
  BUILD_DIR="$THUNDERBOLT_SYNC_DERIVED_DATA"
  OWNS_BUILD_DIR=0
else
  BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/thunderbolt-ios-sync-build.XXXXXX")"
  OWNS_BUILD_DIR=1
fi
BACKEND_LOG="${TMPDIR:-/tmp}/thunderbolt-native-sync-backend-${$}.log"
PROVIDER_LOG="${TMPDIR:-/tmp}/thunderbolt-native-sync-provider-${$}.log"
BUILD_LOG="${TMPDIR:-/tmp}/thunderbolt-native-sync-build-${$}.log"
TEST_LOG="${TMPDIR:-/tmp}/thunderbolt-native-sync-tests-${$}.log"
MIGRATION_LOG="${TMPDIR:-/tmp}/thunderbolt-native-sync-migrate-${$}.log"
RESULT_BUNDLE="${THUNDERBOLT_SYNC_RESULT_BUNDLE:-${TMPDIR:-/tmp}/Thunderbolt-native-sync-${$}.xcresult}"
UI_RESULT_BUNDLE="${RESULT_BUNDLE%.xcresult}-ui.xcresult"
MONITORING_TOKEN=thunderbolt-native-ios-sync-monitoring-token-32
BACKEND_PID=""
PROVIDER_PID=""
OWNS_STACK=0
COMPOSE=(docker compose -p "$SYNC_COMPOSE_PROJECT" -f "$ROOT_DIR/powersync-service/docker-compose.yml")

cleanup() {
  if [[ -n "$PROVIDER_PID" ]]; then
    kill "$PROVIDER_PID" 2>/dev/null || true
    wait "$PROVIDER_PID" 2>/dev/null || true
  fi
  if [[ -n "$BACKEND_PID" ]]; then
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
  if [[ "$OWNS_STACK" == 1 ]]; then
    POWERSYNC_PORT="$POWERSYNC_PORT" POSTGRES_PORT="$POSTGRES_PORT" "${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  if [[ "$OWNS_BUILD_DIR" == 1 ]]; then
    rm -rf "$BUILD_DIR"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for command in bun docker xcodebuild xcrun lsof curl plutil; do
  command -v "$command" >/dev/null || { printf 'Required command not found: %s\n' "$command" >&2; exit 1; }
done
[[ -d "$ROOT_DIR/backend/node_modules" ]] || {
  printf 'Install backend dependencies first: (cd backend && bun install --frozen-lockfile)\n' >&2
  exit 1
}

for port in "$BACKEND_PORT" "$SYNC_PROVIDER_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    printf 'Port %s is already in use. Set BACKEND_PORT or SYNC_PROVIDER_PORT to a free port.\n' "$port" >&2
    exit 1
  fi
done

compose_has_containers() {
  [[ -n "$(POWERSYNC_PORT="$POWERSYNC_PORT" POSTGRES_PORT="$POSTGRES_PORT" "${COMPOSE[@]}" ps --all -q 2>/dev/null)" ]]
}

if [[ "$REUSE_SYNC_STACK" == 1 ]]; then
  compose_has_containers || {
    printf 'No containers found for compose project %s; start that isolated project first or omit THUNDERBOLT_REUSE_SYNC_STACK=1.\n' "$SYNC_COMPOSE_PROJECT" >&2
    exit 1
  }
  for service in postgres powersync; do
    [[ -n "$(POWERSYNC_PORT="$POWERSYNC_PORT" POSTGRES_PORT="$POSTGRES_PORT" "${COMPOSE[@]}" ps -q "$service")" ]] || {
      printf 'Compose project %s is missing service %s.\n' "$SYNC_COMPOSE_PROJECT" "$service" >&2
      exit 1
    }
  done
else
  if compose_has_containers; then
    printf 'Generated Compose project %s already exists; choose a fresh run or explicitly reuse an isolated project.\n' "$SYNC_COMPOSE_PROJECT" >&2
    exit 1
  fi
  for port in "$POWERSYNC_PORT" "$POSTGRES_PORT"; do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      printf 'Sync stack port %s is already in use. Reuse only its isolated compose project with THUNDERBOLT_REUSE_SYNC_STACK=1 SYNC_COMPOSE_PROJECT=...\n' "$port" >&2
      exit 1
    fi
  done
  OWNS_STACK=1
  POWERSYNC_PORT="$POWERSYNC_PORT" POSTGRES_PORT="$POSTGRES_PORT" "${COMPOSE[@]}" up -d
fi

wait_for_tcp() {
  local port="$1" label="$2"
  for _ in $(seq 1 90); do
    if curl --silent --output /dev/null --max-time 1 "http://127.0.0.1:${port}/" 2>/dev/null; then return 0; fi
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then return 0; fi
    if [[ "$OWNS_STACK" == 1 ]] && ! compose_has_containers; then
      printf 'PowerSync/Postgres compose stack exited during startup.\n' >&2
      return 1
    fi
    sleep 1
  done
  printf 'Timed out waiting for %s on port %s.\n' "$label" "$port" >&2
  return 1
}

wait_for_tcp "$POSTGRES_PORT" "Postgres"
wait_for_tcp "$POWERSYNC_PORT" "PowerSync"

wait_for_powersync() {
  for _ in $(seq 1 90); do
    if curl --silent --fail --output /dev/null --max-time 1 "${POWERSYNC_URL}/probes/liveness"; then return 0; fi
    if [[ "$OWNS_STACK" == 1 ]] && ! compose_has_containers; then
      printf 'PowerSync/Postgres compose stack exited during startup.\n' >&2
      return 1
    fi
    sleep 1
  done
  printf 'Timed out waiting for PowerSync liveness at %s/probes/liveness.\n' "$POWERSYNC_URL" >&2
  return 1
}
wait_for_powersync

(
  cd "$ROOT_DIR/backend"
  exec env \
    NODE_ENV=test \
    DATABASE_DRIVER=postgres \
    DATABASE_URL="postgres://postgres:postgres@localhost:${POSTGRES_PORT}/postgres" \
    AUTH_MODE=consumer \
    RATE_LIMIT_ENABLED=false \
    ORG_ESCROW_ENABLED=false \
    MIN_APP_VERSION='' \
    POWERSYNC_URL="$POWERSYNC_URL" \
    POWERSYNC_JWT_SECRET=powersync-dev-secret-change-in-production \
    POWERSYNC_JWT_KID=powersync-dev \
    bun run db migrate
) >"$MIGRATION_LOG" 2>&1 || {
  tail -n 80 "$MIGRATION_LOG" >&2
  exit 1
}

(
  cd "$ROOT_DIR/backend"
  exec env \
    NODE_ENV=test \
    DATABASE_DRIVER=postgres \
    DATABASE_URL="postgres://postgres:postgres@localhost:${POSTGRES_PORT}/postgres" \
    AUTH_MODE=consumer \
    RATE_LIMIT_ENABLED=false \
    ORG_ESCROW_ENABLED=false \
    MIN_APP_VERSION='' \
    PORT="$BACKEND_PORT" \
    HOST=localhost \
    APP_URL="http://localhost:${BACKEND_PORT}" \
    BETTER_AUTH_URL="http://localhost:${BACKEND_PORT}" \
    BETTER_AUTH_SECRET=thunderbolt-native-ios-sync-test-secret-32 \
    MONITORING_TOKEN="$MONITORING_TOKEN" \
    WAITLIST_AUTO_APPROVE_DOMAINS=thunderbolt.io \
    ANTHROPIC_API_KEY=thunderbolt-native-ios-fake-provider-key \
    ANTHROPIC_BASE_URL="http://localhost:${SYNC_PROVIDER_PORT}" \
    POWERSYNC_URL="$POWERSYNC_URL" \
    POWERSYNC_JWT_SECRET=powersync-dev-secret-change-in-production \
    POWERSYNC_JWT_KID=powersync-dev \
    bun src/index.ts
) >"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

wait_for_backend() {
  for _ in $(seq 1 90); do
    if curl --silent --fail --output /dev/null --max-time 1 "${BACKEND_URL}/health"; then return 0; fi
    if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
      printf 'Backend exited before becoming ready. See %s\n' "$BACKEND_LOG" >&2
      return 1
    fi
    sleep 1
  done
  printf 'Timed out waiting for backend at %s. See %s\n' "$BACKEND_URL" "$BACKEND_LOG" >&2
  return 1
}
wait_for_backend

wait_for_dependency_readiness() {
  for _ in $(seq 1 90); do
    if curl --silent --fail --output /dev/null --max-time 2 \
      -H "Authorization: Bearer ${MONITORING_TOKEN}" "${BACKEND_URL}/health/database" && \
      curl --silent --fail --output /dev/null --max-time 2 \
      -H "Authorization: Bearer ${MONITORING_TOKEN}" "${BACKEND_URL}/health/powersync"; then
      return 0
    fi
    if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
      printf 'Backend exited before dependency readiness. See %s\n' "$BACKEND_LOG" >&2
      return 1
    fi
    sleep 1
  done
  printf 'Timed out waiting for database and PowerSync readiness after migrations. See %s\n' "$BACKEND_LOG" >&2
  return 1
}
wait_for_dependency_readiness

(
  cd "$ROOT_DIR"
  exec env NODE_PATH="$ROOT_DIR/backend/node_modules" SYNC_PROVIDER_PORT="$SYNC_PROVIDER_PORT" \
    bun -e 'import { createFakeProvider } from "./e2e/fake-provider.ts"; await createFakeProvider(Number(process.env.SYNC_PROVIDER_PORT))'
) >"$PROVIDER_LOG" 2>&1 &
PROVIDER_PID=$!

wait_for_provider() {
  for _ in $(seq 1 60); do
    if curl --silent --output /dev/null --max-time 1 "http://127.0.0.1:${SYNC_PROVIDER_PORT}/health" 2>/dev/null; then return 0; fi
    if ! kill -0 "$PROVIDER_PID" 2>/dev/null; then
      printf 'Fake Anthropic provider exited before becoming ready. See %s\n' "$PROVIDER_LOG" >&2
      return 1
    fi
    sleep 1
  done
  printf 'Timed out waiting for fake Anthropic provider on port %s. See %s\n' "$SYNC_PROVIDER_PORT" "$PROVIDER_LOG" >&2
  return 1
}
wait_for_provider

PLIST_BUDDY=/usr/libexec/PlistBuddy
XCTESTRUN=""
if [[ -n "$SUPPLIED_XCTESTRUN" ]]; then
  [[ -f "$SUPPLIED_XCTESTRUN" ]] || {
    printf 'THUNDERBOLT_SYNC_XCTESTRUN is not a file: %s\n' "$SUPPLIED_XCTESTRUN" >&2
    exit 1
  }
  [[ -d "$BUILD_DIR" ]] || {
    printf 'Set THUNDERBOLT_SYNC_DERIVED_DATA to the DerivedData directory that produced the supplied test plan.\n' >&2
    exit 1
  }
  BUILD_PRODUCTS="$(cd "$BUILD_DIR/Build/Products" 2>/dev/null && pwd -P)" || {
    printf 'The supplied DerivedData directory has no Build/Products folder: %s\n' "$BUILD_DIR" >&2
    exit 1
  }
  XCTESTRUN="$(cd "$(dirname "$SUPPLIED_XCTESTRUN")" && pwd -P)/$(basename "$SUPPLIED_XCTESTRUN")"
  case "$XCTESTRUN" in
    "$BUILD_PRODUCTS"/*.xctestrun) ;;
    *)
      printf 'The supplied .xctestrun must live directly in the selected DerivedData Build/Products directory.\n' >&2
      exit 1
      ;;
  esac
  plutil -lint "$XCTESTRUN" >/dev/null || {
    printf 'The supplied test plan is not a valid plist: %s\n' "$XCTESTRUN" >&2
    exit 1
  }
  "$PLIST_BUDDY" -c 'Print :ThunderboltTests' "$XCTESTRUN" >/dev/null 2>&1 &&
    "$PLIST_BUDDY" -c 'Print :ThunderboltUITests' "$XCTESTRUN" >/dev/null 2>&1 || {
      printf 'The supplied test plan must include ThunderboltTests and ThunderboltUITests.\n' >&2
      exit 1
    }
  for target in ThunderboltTests ThunderboltUITests; do
    bundle_path="$("$PLIST_BUDDY" -c "Print :${target}:TestBundlePath" "$XCTESTRUN" 2>/dev/null || true)"
    host_path="$("$PLIST_BUDDY" -c "Print :${target}:TestHostPath" "$XCTESTRUN" 2>/dev/null || true)"
    case "$host_path" in
      __TESTROOT__/*) host_path="${host_path#__TESTROOT__/}" ;;
      *)
        printf 'Unexpected test host path for %s in supplied plan: %s\n' "$target" "$host_path" >&2
        exit 1
        ;;
    esac
    case "$bundle_path" in
      __TESTHOST__/*) bundle_path="${bundle_path#__TESTHOST__/}" ;;
      *)
        printf 'Unexpected test bundle path for %s in supplied plan: %s\n' "$target" "$bundle_path" >&2
        exit 1
        ;;
    esac
    [[ -d "$BUILD_PRODUCTS/$host_path/$bundle_path" ]] || {
      printf 'Compiled test product is missing for %s: %s\n' "$target" "$BUILD_PRODUCTS/$host_path/$bundle_path" >&2
      exit 1
    }
  done
  printf 'Reusing compiled test products from %s\n' "$XCTESTRUN"
else
  printf 'Building iOS test products…\n'
  xcodebuild build-for-testing \
    -project "$ROOT_DIR/ios/Thunderbolt.xcodeproj" \
    -scheme Thunderbolt \
    -destination "$DESTINATION" \
    -derivedDataPath "$BUILD_DIR" \
    -clonedSourcePackagesDirPath "$PACKAGE_CACHE" \
    -parallel-testing-enabled NO \
    CODE_SIGN_IDENTITY=- >"$BUILD_LOG" 2>&1 || {
      tail -n 80 "$BUILD_LOG" >&2
      printf 'Build log: %s\n' "$BUILD_LOG" >&2
      exit 1
    }
  while IFS= read -r candidate; do
    candidate_name="$(basename "$candidate")"
    [[ "$candidate_name" == *-sync*.xctestrun || "$candidate_name" == *Thunderbolt-local-sync* ]] && continue
    "$PLIST_BUDDY" -c 'Print :ThunderboltTests' "$candidate" >/dev/null 2>&1 || continue
    "$PLIST_BUDDY" -c 'Print :ThunderboltUITests' "$candidate" >/dev/null 2>&1 || continue
    if [[ -z "$XCTESTRUN" || "$candidate" -nt "$XCTESTRUN" ]]; then
      XCTESTRUN="$candidate"
    fi
  done < <(find "$BUILD_DIR/Build/Products" -maxdepth 1 -type f -name '*.xctestrun' -print)
fi
[[ -n "$XCTESTRUN" ]] || {
  printf 'xcodebuild did not produce a fresh .xctestrun plan containing both ThunderboltTests and ThunderboltUITests. See %s\n' "$BUILD_LOG" >&2
  exit 1
}
CONFIGURED_XCTESTRUN="${XCTESTRUN%.xctestrun}-sync-$$.xctestrun"
cp "$XCTESTRUN" "$CONFIGURED_XCTESTRUN"
set_test_environment() {
  local target="$1" name="$2" value="$3"
  local env_path=":${target}:EnvironmentVariables"
  local variable_path="${env_path}:${name}"
  if ! "$PLIST_BUDDY" -c "Print :${target}" "$CONFIGURED_XCTESTRUN" >/dev/null 2>&1; then
    printf 'The test plan does not contain %s. See %s\n' "$target" "$BUILD_LOG" >&2
    return 1
  fi
  if ! "$PLIST_BUDDY" -c "Print ${env_path}" "$CONFIGURED_XCTESTRUN" >/dev/null 2>&1; then
    "$PLIST_BUDDY" -c "Add ${env_path} dict" "$CONFIGURED_XCTESTRUN"
  fi
  if "$PLIST_BUDDY" -c "Print ${variable_path}" "$CONFIGURED_XCTESTRUN" >/dev/null 2>&1; then
    "$PLIST_BUDDY" -c "Set ${variable_path} ${value}" "$CONFIGURED_XCTESTRUN"
  else
    "$PLIST_BUDDY" -c "Add ${variable_path} string ${value}" "$CONFIGURED_XCTESTRUN"
  fi
}
set_test_environment ThunderboltTests THUNDERBOLT_INTEGRATION_URL "$BACKEND_URL"
set_test_environment ThunderboltUITests THUNDERBOLT_UI_SYNC_SERVER "$BACKEND_URL"
set_test_environment ThunderboltUITests THUNDERBOLT_UI_BACKEND_LOG "$BACKEND_LOG"

printf 'Running encrypted PowerSync device integration against %s…\n' "$BACKEND_URL"
xcodebuild test-without-building \
  -xctestrun "$CONFIGURED_XCTESTRUN" \
  -destination "$DESTINATION" \
  -derivedDataPath "$BUILD_DIR" \
  -clonedSourcePackagesDirPath "$PACKAGE_CACHE" \
  -parallel-testing-enabled NO \
  -only-testing:ThunderboltTests/DeviceIntegrationTests/testBootstrapRebindAndEncryptedPowerSyncReplication \
  -resultBundlePath "$RESULT_BUNDLE" \
  CODE_SIGN_IDENTITY=- >"$TEST_LOG" 2>&1 || {
    tail -n 100 "$TEST_LOG" >&2
    printf 'Test log: %s\n' "$TEST_LOG" >&2
    exit 1
  }
printf 'Running native chat, sync, account, preferences and tasks UI flows…\n'
xcodebuild test-without-building \
  -xctestrun "$CONFIGURED_XCTESTRUN" \
  -destination "$DESTINATION" \
  -derivedDataPath "$BUILD_DIR" \
  -clonedSourcePackagesDirPath "$PACKAGE_CACHE" \
  -parallel-testing-enabled NO \
  -only-testing:ThunderboltUITests \
  -resultBundlePath "$UI_RESULT_BUNDLE" \
  CODE_SIGN_IDENTITY=- >"${TEST_LOG%.log}-ui.log" 2>&1 || {
    tail -n 100 "${TEST_LOG%.log}-ui.log" >&2
    printf 'UI test log: %s\n' "${TEST_LOG%.log}-ui.log" >&2
    exit 1
  }
printf 'Unit integration result: %s\nUI result: %s\nMigration log: %s\nBackend log: %s\nFake provider log: %s\nBuild log: %s\nUnit integration log: %s\nUI log: %s\n' \
  "$RESULT_BUNDLE" "$UI_RESULT_BUNDLE" "$MIGRATION_LOG" "$BACKEND_LOG" "$PROVIDER_LOG" "$BUILD_LOG" "$TEST_LOG" "${TEST_LOG%.log}-ui.log"
