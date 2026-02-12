#!/usr/bin/env bash
# sim.sh — Realtime query bombardment engine
#
# Fires queries at a live ES cluster with realistic timing and phased
# intensity. The cluster itself is the observable — the agent watches
# ES endpoints (_stats, _cluster/health, slow log, etc.) in real time,
# not our output. We just create the traffic pattern.

# ── Phase registry ──────────────────────────────────────────────────────────

_SIM_PHASES=()        # "name|duration_s|qps|pool_fn"
_SIM_PORT=""
_SIM_QUERY_COUNT=0

sim_add_phase() {
  # Usage: sim_add_phase <name> <duration_seconds> <queries_per_second> <pool_function>
  _SIM_PHASES+=("${1}|${2}|${3}|${4}")
}

# ── Fire one query ──────────────────────────────────────────────────────────

_sim_fire() {
  local pool_fn="$1"

  local pick
  pick=$($pool_fn)
  local method path body
  method=$(echo "$pick" | cut -d'|' -f2)
  path=$(echo "$pick" | cut -d'|' -f3)
  body=$(echo "$pick" | cut -d'|' -f4-)

  # Fire and discard — ES records the stats, not us
  curl -s -o /dev/null \
    -X "$method" \
    -u "elastic:${ELASTIC_PASSWORD}" \
    -H "Content-Type: application/json" \
    "http://localhost:${_SIM_PORT}${path}" \
    -d "$body" 2>/dev/null &

  ((_SIM_QUERY_COUNT++))
}

# ── Sleep with jitter ───────────────────────────────────────────────────────

_sim_sleep() {
  local qps="$1"
  # 1/qps ± 30% jitter
  python3 -c "
import time, random
base = 1.0 / $qps
jitter = base * 0.3 * (2 * random.random() - 1)
time.sleep(max(0.05, base + jitter))
"
}

# ── Run all phases ──────────────────────────────────────────────────────────

sim_run() {
  # Usage: sim_run <port> <id> <eval_name>
  _SIM_PORT="$1"
  local id="$2" eval_name="$3"
  _SIM_QUERY_COUNT=0

  local total_duration=0
  for spec in "${_SIM_PHASES[@]}"; do
    total_duration=$(( total_duration + $(echo "$spec" | cut -d'|' -f2) ))
  done

  log "Starting: $eval_name (${#_SIM_PHASES[@]} phases, ~${total_duration}s)"
  log "The agent should query ES endpoints now to observe the cluster."
  echo "" >&2

  local sim_start
  sim_start=$(date +%s)

  for phase_spec in "${_SIM_PHASES[@]}"; do
    local pname pdur pqps pfn
    pname=$(echo "$phase_spec" | cut -d'|' -f1)
    pdur=$(echo "$phase_spec" | cut -d'|' -f2)
    pqps=$(echo "$phase_spec" | cut -d'|' -f3)
    pfn=$(echo "$phase_spec" | cut -d'|' -f4)

    log "Phase: $pname (${pdur}s @ ${pqps} qps)"

    local phase_start phase_elapsed
    phase_start=$(date +%s)

    while true; do
      phase_elapsed=$(( $(date +%s) - phase_start ))
      (( phase_elapsed >= pdur )) && break

      _sim_fire "$pfn"
      _sim_sleep "$pqps"

      # Minimal progress indicator
      local total_elapsed=$(( $(date +%s) - sim_start ))
      printf '\r  [%ds / %ds]  phase=%-15s  fired=%d  ' \
        "$total_elapsed" "$total_duration" "$pname" "$_SIM_QUERY_COUNT" >&2
    done

    # Wait for any backgrounded curls from this phase to finish
    wait
  done

  echo "" >&2
  local elapsed=$(( $(date +%s) - sim_start ))
  log "Done. $eval_name: ${_SIM_QUERY_COUNT} queries in ${elapsed}s"

  # Reset for next run
  _SIM_PHASES=()
}
