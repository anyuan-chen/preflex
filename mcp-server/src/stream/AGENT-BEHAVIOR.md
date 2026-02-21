# Agent Behavior — Design Notes

These notes define how the monitor agent should behave when anomalies fire.
Used as input when writing the agent system prompt.

## Core Principle

Act autonomously. The system is already degraded when the agent is invoked —
doing nothing has a real cost. Every write tool is non-destructive (creates new
indices, preserves sources) and the verification pipeline validates correctness
before finalizing. Human approval adds latency to an already-broken system.

## Decision Framework

### 1. Always diagnose before acting

Read tools first. The agent must understand what's wrong before proposing a fix.
Minimum: check the relevant index mapping/settings/stats. Don't jump to reindex
because latency is high — confirm the root cause.

### 2. Check cluster capacity before heavy operations

Before starting a reindex or shrink:
- Check node heap (via `node_stats`). If any node > 85%, defer the operation.
- Check search thread pool queue. If queue > 0, the cluster is already saturated.
- If capacity is constrained: diagnose, report findings, but don't add load.
  The agent should say "identified bad mapping on X, deferring reindex until
  cluster pressure subsides" rather than making things worse.

### 3. Act autonomously when safe

Safe = all of:
- The fix is non-destructive (new index created, source preserved)
- The cluster has capacity (heap < 85%, no thread pool saturation)
- The verification pipeline will validate the result

All our write tools meet the first condition by design:
- `reindex`: new target index, source untouched, rollback = delete target
- `shrink_index`: new target index, source untouched, rollback = delete target
- `update_settings`: dynamic setting change, rollback = restore old value
- `manage_aliases`: atomic swap, rollback = ES handles it
- `cancel_task`: kills a query that's already causing harm

### 4. Severity guides urgency, not permission

Both warning and critical anomalies trigger autonomous action. The difference
is priority, not whether to act:
- Critical (cluster_red, node_drop, latency > 4x): investigate immediately
- Warning (cluster_yellow, latency > 2x, heap pressure): investigate, may
  defer action if cluster is under pressure

## Per-Anomaly Playbook

### latency_spike
1. `index_mapping` — check for text fields that should be keyword/date
2. `index_stats` — check shard count, fielddata evictions
3. `shard_info` — check for imbalance
4. `query_profile` on a representative query — confirm where time is spent
5. If bad mapping → `reindex` with corrected mapping
6. If over-sharded → `shrink_index`
7. If bad setting → `update_settings`

### cluster_red / cluster_yellow
1. `cluster_health` with shard-level detail
2. `allocation_explain` — why are shards unassigned?
3. If unassigned replicas + not enough nodes → `update_settings` to reduce replicas
4. If other cause → report findings

### node_drop
1. `node_stats` — which nodes remain, are they healthy?
2. `cluster_health` — how many shards affected?
3. Report findings. Can't fix infrastructure from here.

### heap_pressure
1. `node_stats` — check fielddata size, query cache size
2. `index_stats` on hot indices — check fielddata evictions
3. Report findings. Can't scale cluster from here.
4. If a specific index is causing fielddata pressure via bad mapping → reindex

### thread_pool_saturation
1. `running_tasks` — what's queued/running?
2. If a single long-running query is blocking everything → `cancel_task`
3. If general overload → report, defer to capacity planning

### query_rate_spike
1. `running_tasks` — is it one client hammering the cluster?
2. If identifiable runaway task → `cancel_task`
3. Otherwise → report, this is an app-side issue

## Constraints

- Max 10 tool calls per invocation. If not resolved, stop and report findings.
- Never drop data. All write operations preserve the source.
- After a write, always verify. The verification pipeline decides pass/fail.
- If verification fails, the rollback already happened. Report what went wrong.
- Don't re-investigate the same anomaly within the cooldown window (5 min).
  The anomaly detector handles this — the agent won't be invoked twice.
