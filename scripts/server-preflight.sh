#!/usr/bin/env bash
# Sourced by bootstrap. These checks do not install packages or change the host.
select_python(){
  local candidate
  if [ -n "${PYTHON:-}" ]; then
    "$PYTHON" -c 'import sys; sys.exit(sys.version_info < (3,10))' >/dev/null 2>&1 || return 1
    return 0
  fi
  for candidate in python3 python3.14 python3.13 python3.12 python3.11 python3.10; do
    if command -v "$candidate" >/dev/null && "$candidate" -c 'import sys; sys.exit(sys.version_info < (3,10))' >/dev/null 2>&1; then
      PYTHON="$(command -v "$candidate")"
      return 0
    fi
  done
  return 1
}

build_memory_available(){
  # A conservative floor, not a guarantee. Check only when building is necessary.
  # Prefer matching artifacts or another build host over changing swap settings.
  local available
  available=$(awk '/^MemAvailable:/ {m=$2} /^SwapFree:/ {s=$2} END {print m+s}' "${1:-/proc/meminfo}") || return 1
  [ "$available" -ge "${BUILD_MIN_MEMORY_KB:-1572864}" ]
}
