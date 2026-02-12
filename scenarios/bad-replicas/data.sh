#!/usr/bin/env bash
# bad-replicas/data.sh — Load data into both replica-misconfigured indices

load_bad_replicas_data() {
  local port="$1" id="$2"

  # Load events into over-replicated index
  local index1="sb-${id}-bad-replicas-overreplicated"
  log "Generating 300 event documents for $index1"

  local events=("user.login" "user.logout" "user.signup" "order.created" "order.completed" "payment.processed" "payment.failed" "item.viewed" "cart.updated" "session.expired")

  local bulk_data=""
  local total=0

  for i in $(seq 1 300); do
    local event="${events[$((RANDOM % ${#events[@]}))]}"
    local uid="user-$((RANDOM % 200))"
    local ts
    ts=$(date -u -v-$((RANDOM % 1440))M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
         date -u -d "-$((RANDOM % 1440)) minutes" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
         echo "2026-02-12T$(printf '%02d' $((RANDOM % 24))):$(printf '%02d' $((RANDOM % 60))):$(printf '%02d' $((RANDOM % 60)))Z")

    bulk_data+='{"index":{"_index":"'"$index1"'"}}'$'\n'
    bulk_data+='{"timestamp":"'"$ts"'","event":"'"$event"'","user_id":"'"$uid"'","details":"Event '"$event"' for user '"$uid"'"}'$'\n'
    ((total++))
  done
  bulk_load "$port" "$bulk_data"
  refresh_index "$port" "$index1"
  log "Loaded $total documents into $index1"

  # Load orders into no-replica critical index
  local index2="sb-${id}-bad-replicas-critical-noreplica"
  log "Generating 200 order documents for $index2"

  local statuses=("pending" "confirmed" "shipped" "delivered" "cancelled" "refunded")
  local currencies=("USD" "EUR" "GBP" "JPY" "CAD")

  bulk_data=""
  total=0

  for i in $(seq 1 200); do
    local order="ORD-$(printf '%06d' $((RANDOM * RANDOM % 999999)))"
    local customer="customer-$((RANDOM % 100))"
    local amount="$((RANDOM % 1000 + 10)).$((RANDOM % 99))"
    local currency="${currencies[$((RANDOM % ${#currencies[@]}))]}"
    local status="${statuses[$((RANDOM % ${#statuses[@]}))]}"
    local ts
    ts=$(date -u -v-$((RANDOM % 1440))M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
         date -u -d "-$((RANDOM % 1440)) minutes" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
         echo "2026-02-12T$(printf '%02d' $((RANDOM % 24))):$(printf '%02d' $((RANDOM % 60))):$(printf '%02d' $((RANDOM % 60)))Z")

    bulk_data+='{"index":{"_index":"'"$index2"'"}}'$'\n'
    bulk_data+='{"timestamp":"'"$ts"'","order_id":"'"$order"'","customer":"'"$customer"'","amount":'"$amount"',"currency":"'"$currency"'","status":"'"$status"'"}'$'\n'
    ((total++))
  done
  bulk_load "$port" "$bulk_data"
  refresh_index "$port" "$index2"
  log "Loaded $total documents into $index2"
}
