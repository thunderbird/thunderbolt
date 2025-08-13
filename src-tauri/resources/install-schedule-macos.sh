#!/usr/bin/env bash
set -euo pipefail

# --- Configuration (tweakables) ---

# macOS change: Default to a reverse-DNS style label, common for launchd
APP_ID="${APP_ID:-net.ghostcat.scheduler}"

# Script + template locations
SCRIPT_NAME="$(basename "$0")"
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"

# macOS change: We only need one template for the .plist file
PLIST_TEMPLATE="${SCRIPT_DIR}/${APP_ID}.plist.template"

# macOS change: Destination is ~/Library/LaunchAgents
DEST_DIR="$HOME/Library/LaunchAgents"
PLIST_DEST_FILE="${DEST_DIR}/${APP_ID}.plist"

# --- Args ---

# macOS change: Removed 'description' as it's not a standard launchd key.
# The 'Label' (APP_ID) serves as the primary identifier.
HOUR="${1:-}"
MINUTE="${2:-}"
EXE_PATH="${3:-}"

# --- Derived paths ---

# Create log directory path based on APP_ID
LOG_DIR="$HOME/Library/Logs/${APP_ID}"
STDOUT_PATH="${LOG_DIR}/stdout.log"
STDERR_PATH="${LOG_DIR}/stderr.log"

# --- Functions ---

usage() {
  cat <<EOF
Usage: $SCRIPT_NAME HH MM /path/to/exe

Installs a user-specific launchd agent on macOS.

Arguments:
  HH             Hour (00-23)
  MM             Minute (00-59)
  /path/to/exe   Full absolute path to the executable

Environment:
  APP_ID         The unique label for the launchd job (default: ${APP_ID})

Example:
  $SCRIPT_NAME 14 15 /Users/ghost/my-app/bin/monitor
  APP_ID=com.mycompany.backup $SCRIPT_NAME 02 30 /usr/local/bin/backup.sh
EOF
}

# This function is portable and remains unchanged.
sed_escape() {
  printf '%s' "$1" | sed -e 's/[&]/\\&/g' -e 's/\\/\\\\/g' -e 's/#/\\#/g'
}

# This function is portable and remains unchanged.
validate_time() {
  local hour="$1" minute="$2"
  if ! [[ "$hour" =~ ^([01]?[0-9]|2[0-3])$ ]]; then
    echo "Error: Hour must be 00-23 (got: $hour)" >&2
    return 1
  fi
  if ! [[ "$minute" =~ ^([0-5]?[0-9])$ ]]; then
    echo "Error: Minute must be 00-59 (got: $minute)" >&2
    return 1
  fi
}

validate_app_id() {
  local app_id="$1"
  # Basic validation for reverse-DNS format
  if ! [[ "$app_id" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ ]]; then
    echo "Error: APP_ID must be a valid reverse-DNS identifier (got: $app_id)" >&2
    echo "Example: com.example.myapp or net.mysite.scheduler" >&2
    return 1
  fi
  if [[ "$app_id" =~ \.\. ]]; then
    echo "Error: APP_ID cannot contain consecutive dots (got: $app_id)" >&2
    return 1
  fi
}

# This function is portable and remains unchanged.
validate_executable() {
  local exe_path="$1"
  if [[ "$exe_path" != /* ]]; then
    echo "Error: Executable path must be absolute (got: $exe_path)" >&2
    return 1
  fi
  if [ ! -f "$exe_path" ]; then
    echo "Error: Executable file not found: $exe_path" >&2
    return 1
  fi
  if [ ! -x "$exe_path" ]; then
    echo "Error: File is not executable: $exe_path" >&2
    return 1
  fi
  if [[ "$exe_path" =~ [[:space:]] ]]; then
    echo "Warning: Executable path contains whitespace. This should work with ProgramArguments array format." >&2
  fi
}

# This function is portable and remains unchanged.
write_plist_from_template() {
  local template="$1" dest="$2" tmp
  shift 2
  # Remaining args are "PLACEHOLDER=VALUE" pairs

  echo "Creating: $dest"
  tmp="$(mktemp "${dest}.XXXXXX")" || { echo "Error: mktemp failed" >&2; return 1; }
  trap 'rm -f -- "$tmp"' RETURN

  local sed_expr=()
  local kv k v escv
  for kv in "$@"; do
    k="${kv%%=*}"; v="${kv#*=}"
    if [[ "$k" = "$v" ]]; then
      echo "Error: Invalid placeholder format '$kv' (expected KEY=VALUE)" >&2
      return 1
    fi
    escv="$(sed_escape "$v")"
    sed_expr+=(-e "s#${k}#${escv}#g")
  done

  if ! sed "${sed_expr[@]}" "$template" > "$tmp"; then
    echo "Error: Failed to process template $template" >&2
    return 1
  fi

  chmod 0644 "$tmp" || { echo "Error: chmod failed: $tmp" >&2; return 1; }
  if ! mv -- "$tmp" "$dest"; then
    echo "Error: Failed to create $dest" >&2
    return 1
  fi
  trap - RETURN
}

main() {
  if [ "$#" -eq 1 ] && { [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; }; then
    usage; exit 0
  fi

  # macOS change: Updated argument check
  if [ -z "$HOUR" ] || [ -z "$MINUTE" ] || [ -z "$EXE_PATH" ]; then
    echo "Error: Missing arguments." >&2; echo >&2; usage >&2; exit 1
  fi

  # Validate all inputs
  validate_app_id "$APP_ID"
  validate_time "$HOUR" "$MINUTE"
  validate_executable "$EXE_PATH"

  # macOS change: Check for a single plist template
  [ -r "$PLIST_TEMPLATE" ] || { echo "Error: Plist template not readable: $PLIST_TEMPLATE" >&2; exit 1; }

  echo "Setting up launchd agent in: $DEST_DIR"
  echo "Log files will be created in: $LOG_DIR"

  if ! mkdir -p "$DEST_DIR"; then
    echo "Error: Failed to create destination directory: $DEST_DIR" >&2
    exit 1
  fi

  # Create log directory
  if ! mkdir -p "$LOG_DIR"; then
    echo "Error: Failed to create log directory: $LOG_DIR" >&2
    exit 1
  fi

  # Zero-pad the time values for consistency
  printf -v PAD_HOUR   "%02d" "$HOUR"
  printf -v PAD_MINUTE "%02d" "$MINUTE"

  # macOS change: We only need to write one file with all placeholders
  write_plist_from_template "$PLIST_TEMPLATE" "$PLIST_DEST_FILE" \
    "PLACEHOLDER_LABEL=$APP_ID" \
    "PLACEHOLDER_EXE_PATH=$EXE_PATH" \
    "PLACEHOLDER_HOUR=$PAD_HOUR" \
    "PLACEHOLDER_MINUTE=$PAD_MINUTE" \
    "PLACEHOLDER_STDOUT_PATH=$STDOUT_PATH" \
    "PLACEHOLDER_STDERR_PATH=$STDERR_PATH"

  echo
  echo "✓ Successfully created launchd agent:"
  echo "  Plist: $PLIST_DEST_FILE"
  echo "  Logs:  $LOG_DIR/"
  echo
  echo "Next steps:"
  echo "1) Load (enable and start) the new agent:"
  echo "   launchctl bootstrap gui/\$(id -u) \"$PLIST_DEST_FILE\""
  echo "2) To test it immediately (without waiting for the schedule):"
  echo "   launchctl kickstart -k gui/\$(id -u)/${APP_ID}"
  echo "3) Check status:"
  echo "   launchctl print gui/\$(id -u)/${APP_ID}"
  echo "4) View logs:"
  echo "   tail -f \"$STDOUT_PATH\""
  echo "   tail -f \"$STDERR_PATH\""
  echo "5) View recent job history:"
  echo "   launchctl history gui/\$(id -u)/${APP_ID}"
  echo "6) To unload (disable) the agent:"
  echo "   launchctl bootout gui/\$(id -u) \"$PLIST_DEST_FILE\""
  echo
  echo "Note: The job will run daily at ${PAD_HOUR}:${PAD_MINUTE}"
}

# Pass all script arguments to the main function
main "$@"
