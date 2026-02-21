#!/usr/bin/env bash
# bad-replicas/data.sh — Load data into both replica-misconfigured indices

load_bad_replicas_data() {
  local port="$1" id="$2"

  # Load events into over-replicated appointments index
  local index1="sb-${id}-appointments"
  log "Generating 300 appointment documents for $index1"

  local events=("appointment.booked" "appointment.completed" "walk-in" "key-pickup" "consultation" "estimate" "appointment.cancelled" "appointment.rescheduled")

  local bulk_data=""
  local total=0

  for i in $(seq 1 300); do
    local event="${events[$((RANDOM % ${#events[@]}))]}"
    local cid="cust-$((RANDOM % 200))"
    local ts
    ts=$(date -u -v-$((RANDOM % 1440))M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
         date -u -d "-$((RANDOM % 1440)) minutes" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
         echo "2026-02-12T$(printf '%02d' $((RANDOM % 24))):$(printf '%02d' $((RANDOM % 60))):$(printf '%02d' $((RANDOM % 60)))Z")

    bulk_data+='{"index":{"_index":"'"$index1"'"}}'$'\n'
    bulk_data+='{"timestamp":"'"$ts"'","event":"'"$event"'","customer_id":"'"$cid"'","details":"'"$event"' for customer '"$cid"'"}'$'\n'
    ((total++))
  done
  bulk_load "$port" "$bulk_data"
  refresh_index "$port" "$index1"
  log "Loaded $total documents into $index1"

  # Load invoices into no-replica critical billing index
  local index2="sb-${id}-customer-billing"
  log "Generating 200 invoice documents for $index2"

  local statuses=("pending" "paid" "overdue" "refunded")
  local currencies=("USD" "CAD")

  bulk_data=""
  total=0

  for i in $(seq 1 200); do
    local invoice="INV-$(printf '%06d' $((RANDOM * RANDOM % 999999)))"
    local customer="cust-$((RANDOM % 100))"
    local amount="$((RANDOM % 500 + 10)).$((RANDOM % 99))"
    local currency="${currencies[$((RANDOM % ${#currencies[@]}))]}"
    local status="${statuses[$((RANDOM % ${#statuses[@]}))]}"
    local ts
    ts=$(date -u -v-$((RANDOM % 1440))M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
         date -u -d "-$((RANDOM % 1440)) minutes" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
         echo "2026-02-12T$(printf '%02d' $((RANDOM % 24))):$(printf '%02d' $((RANDOM % 60))):$(printf '%02d' $((RANDOM % 60)))Z")

    bulk_data+='{"index":{"_index":"'"$index2"'"}}'$'\n'
    bulk_data+='{"timestamp":"'"$ts"'","invoice_id":"'"$invoice"'","customer":"'"$customer"'","amount":'"$amount"',"currency":"'"$currency"'","status":"'"$status"'"}'$'\n'
    ((total++))
  done
  bulk_load "$port" "$bulk_data"
  refresh_index "$port" "$index2"
  log "Loaded $total documents into $index2"
}
