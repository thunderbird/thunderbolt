#!/usr/bin/env bash
set -euo pipefail

# --- Configuration (tweakables) ---

# Allow unit name override via env; default to "ghostcat"
UNIT_BASENAME="${UNIT_BASENAME:-ghostcat}"

# Script + template locations
SCRIPT_NAME="$(basename "$0")"
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"

SERVICE_TEMPLATE="${SCRIPT_DIR}/${UNIT_BASENAME}.service.template"
TIMER_TEMPLATE="${SCRIPT_DIR}/${UNIT_BASENAME}.timer.template"

# Respect XDG config home
DEST_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_DEST_FILE="${DEST_DIR}/${UNIT_BASENAME}.service"
TIMER_DEST_FILE="${DEST_DIR}/${UNIT_BASENAME}.timer"

# --- Args ---

DESCRIPTION="${1:-}"
HOUR="${2:-}"
MINUTE="${3:-}"
EXE_PATH="${4:-}"

# --- Functions ---

usage() {
  # Use here-doc with variable substitution for script name
  cat <<EOF
Usage: $SCRIPT_NAME "Description" HH MM /path/to/exe

Arguments:
  Description    Service description (quote if it contains spaces)
  HH             Hour (00-23)
  MM             Minute (00-59)
  /path/to/exe   Full absolute path to the executable

Environment:
  UNIT_BASENAME  Base name for generated units (default: ghostcat)

Examples:
  UNIT_BASENAME=backup $SCRIPT_NAME "Nightly backup" 02 30 /usr/local/bin/backup.sh
  $SCRIPT_NAME "System Monitor" 14 15 /home/user/monitor.py
EOF
}

sed_escape() {
  # Escape sed replacement string special characters when using '#' as delimiter
  # Escapes: & and backslashes, and the delimiter '#'
  printf '%s' "$1" | sed -e 's/[&]/\\&/g' -e 's/\\/\\\\/g' -e 's/#/\\#/g'
}

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

validate_description() {
  case "$1" in
    *$'\n'*)
      echo "Error: Description must be a single line (no newlines)." >&2
      return 1;;
    "")
      echo "Error: Description cannot be empty." >&2
      return 1;;
  esac
}

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
    echo "Warning: Executable path contains whitespace. Ensure ExecStart handles it correctly in the template." >&2
  fi
}
write_unit_from_template() {
  local template="$1" dest="$2" tmp
  shift 2
  # Remaining args are "PLACEHOLDER=VALUE" pairs

  echo "Creating: $dest"

  # Create temp file on the same filesystem for atomic rename
  tmp="$(mktemp "${dest}.XXXXXX")" || { echo "Error: mktemp failed" >&2; return 1; }
  # Ensure temp is removed if we return early for any reason
  trap 'rm -f -- "$tmp"' RETURN

  # Build sed command dynamically
  local sed_expr=()
  local kv k v escv
  for kv in "$@"; do
    k="${kv%%=*}"
    v="${kv#*=}"
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

  # Success: we moved tmp, so cancel the RETURN trap
  trap - RETURN
}

main() {
  if [ "$#" -eq 1 ] && { [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; }; then
    usage; exit 0
  fi

  if [ -z "$DESCRIPTION" ] || [ -z "$EXE_PATH" ] || [ -z "$HOUR" ] || [ -z "$MINUTE" ]; then
    echo "Error: Missing arguments." >&2; echo >&2; usage >&2; exit 1
  fi

  validate_description "$DESCRIPTION"
  validate_time "$HOUR" "$MINUTE"
  validate_executable "$EXE_PATH"

  [ -r "$SERVICE_TEMPLATE" ] || { echo "Error: Service template not readable: $SERVICE_TEMPLATE" >&2; exit 1; }
  [ -r "$TIMER_TEMPLATE" ]   || { echo "Error: Timer template not readable: $TIMER_TEMPLATE" >&2; exit 1; }

  echo "Setting up systemd user service and timer in: $DEST_DIR"

  # Create directory with error handling
  if ! mkdir -p "$DEST_DIR"; then
    echo "Error: Failed to create destination directory: $DEST_DIR" >&2
    exit 1
  fi

  umask 022

  printf -v PAD_HOUR   "%02d" "$HOUR"
  printf -v PAD_MINUTE "%02d" "$MINUTE"

  write_unit_from_template "$SERVICE_TEMPLATE" "$SERVICE_DEST_FILE" \
    "PLACEHOLDER_DESCRIPTION=$DESCRIPTION" \
    "PLACEHOLDER_EXE_PATH=$EXE_PATH"

  write_unit_from_template "$TIMER_TEMPLATE" "$TIMER_DEST_FILE" \
    "PLACEHOLDER_DESCRIPTION=$DESCRIPTION" \
    "PLACEHOLDER_HOUR=$PAD_HOUR" \
    "PLACEHOLDER_MINUTE=$PAD_MINUTE"

  echo
  echo "✓ Successfully created systemd units:"
  echo "  Service: $SERVICE_DEST_FILE"
  echo "  Timer:   $TIMER_DEST_FILE"
  echo
  echo "Next steps:"
  echo "1) Reload user daemon:"
  echo "   systemctl --user daemon-reload"
  echo "2) Enable and start the timer:"
  echo "   systemctl --user enable --now ${UNIT_BASENAME}.timer"
  echo "3) Check status:"
  echo "   systemctl --user status ${UNIT_BASENAME}.timer"
  echo "   systemctl --user list-timers"
  echo "4) Optionally verify unit syntax:"
  echo "   systemd-analyze --user verify \"$SERVICE_DEST_FILE\" \"$TIMER_DEST_FILE\""
  echo
  echo "Tip: If you want the timer to run while logged out, run:"
  echo "   loginctl enable-linger \$(whoami)"
}

# Pass all script arguments to the main function
main "$@"
